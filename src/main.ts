import { Notice, Plugin, requestUrl, type TAbstractFile } from "obsidian";
import { SyncController } from "./controller";
import { Custody } from "./custody";
import {
  createDeviceSeed,
  deleteDeviceStorage,
  isStaleWrite,
  linkDevice,
  openDeviceVault,
  pulledStatus,
  SYNC_LOCKED,
  type TrustLoss,
} from "./device";
import { requestUrlFetch } from "./fetch";
import { IndexedDbIndex } from "./index-store";
import { holdLock } from "./lock";
import { confirm, LinkModal } from "./obsidian/modals";
import { NoteSyncSettingTab, statusText } from "./obsidian/settings";
import {
  custodyNote,
  defaultLabel,
  deviceNamespace,
  obsidianSecrets,
  obsidianVault,
} from "./obsidian/vault";

/** Flow ID, which links devices and relays the encrypted vault to the person's PDS. */
const FLOW_ID = "https://id.flow.industries";

export default class NoteSyncPlugin extends Plugin {
  controller!: SyncController;
  private settingTab!: NoteSyncSettingTab;
  private linkModal: LinkModal | null = null;

  override async onload() {
    const namespace = deviceNamespace(this.app);
    const statusBar = this.addStatusBarItem();
    statusBar.onClickEvent(() => void this.controller.syncNow());
    this.controller = new SyncController({
      custody: new Custody(obsidianSecrets(this.app), namespace),
      device: {
        createDeviceSeed,
        linkDevice,
        openDeviceVault,
        locked: SYNC_LOCKED,
        pulled: pulledStatus,
        stale: isStaleWrite,
      },
      host: FLOW_ID,
      fetch: requestUrlFetch(requestUrl),
      local: obsidianVault(this.app),
      configDir: this.app.vault.configDir,
      indexFor: (did, vault) =>
        new IndexedDbIndex(`flow-note-sync:${namespace}:${did}:${vault}`),
      hold: () => holdLock(`flow-note:${namespace}`),
      forgetDevice: deleteDeviceStorage,
      confirmDeletions: ({ local, remote }) =>
        confirm(
          this.app,
          "Delete these files?",
          `This sync would move ${local} files here and ${remote} in NOTE to the trash. That can mean they were deleted on purpose, or that one side looks empty when it isn't. Nothing is deleted unless you confirm.`,
          "Move to trash",
          { warning: true },
        ),
      onChange: () => {
        statusBar.setText(
          statusText(this.controller.phase, this.controller.lastRound),
        );
        this.linkModal?.render();
        if (this.settingTab.containerEl.isShown()) this.settingTab.display();
      },
      onTrustLoss: (loss) => trustLossNotice(loss),
      notify: (message) => new Notice(`FLOW NOTE Sync: ${message}`, 0),
    });
    this.settingTab = new NoteSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.controller.syncNow(),
    });
    this.addCommand({
      id: "link",
      name: "Link this vault",
      callback: () => this.openLink(),
    });
    this.addCommand({
      id: "unlink",
      name: "Unlink this vault",
      callback: async () => {
        if (
          await confirm(
            this.app,
            "Unlink this vault?",
            "Syncing stops and this vault forgets its device key. Your files stay here and in NOTE.",
            "Unlink",
            { warning: true },
          )
        )
          await this.controller.unlink();
      },
    });

    this.app.workspace.onLayoutReady(() => {
      const changed = (file: TAbstractFile) => {
        if (file.path) this.controller.localChanged();
      };
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) =>
          this.controller.renamed(oldPath, file.path),
        ),
      );
      void this.controller.start();
    });
  }

  override onunload() {
    this.linkModal?.close();
    this.controller.close();
  }

  openLink() {
    this.linkModal?.close();
    const modal = new LinkModal(
      this.app,
      this.controller,
      defaultLabel(),
      () =>
        custodyNote(this.app).safe
          ? Promise.resolve(true)
          : confirm(
              this.app,
              "Store the device key unencrypted?",
              custodyNote(this.app).text,
              "Link anyway",
              { warning: true },
            ),
    );
    const close = modal.onClose.bind(modal);
    modal.onClose = () => {
      close();
      if (this.linkModal === modal) this.linkModal = null;
    };
    this.linkModal = modal;
    modal.open();
  }
}

function trustLossNotice({ unsigned, stale }: TrustLoss) {
  const lines = [
    unsigned.length
      ? `Saved without another admin's signature, so their code there won't run by itself in NOTE until someone trusts it: ${unsigned.join(", ")}.`
      : "",
    stale.length
      ? `Links to moved code were left as they were: ${stale.join(", ")}.`
      : "",
  ].filter(Boolean);
  if (lines.length) new Notice(`FLOW NOTE Sync: ${lines.join(" ")}`, 15_000);
}
