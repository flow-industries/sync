import { type App, type Plugin, PluginSettingTab, Setting } from "obsidian";
import type { Phase, SyncController } from "../controller";
import type { RoundResult } from "../engine";
import { accountName, confirm } from "./modals";
import { custodyNote } from "./vault";

/** The status bar's words for each phase. */
export function statusText(phase: Phase, round: RoundResult | null): string {
  switch (phase.kind) {
    case "unlinked":
      return "NOTE: not linked";
    case "linking":
      return "NOTE: linking";
    case "confirm":
      return "NOTE: confirm account";
    case "opening":
      return "NOTE: connecting";
    case "removed":
      return "NOTE: device removed";
    case "stopped":
      return "NOTE: stopped";
    case "open": {
      const failed = round?.failed.length ?? 0;
      const held = (round?.held.local ?? 0) + (round?.held.remote ?? 0);
      return [
        `NOTE: ${phase.status}`,
        failed ? `${failed} not synced` : "",
        held ? `${held} deletions held` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }
}

export interface SettingsHost extends Plugin {
  controller: SyncController;
  openLink(): void;
}

export class NoteSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost,
  ) {
    super(app, host);
  }

  override display() {
    const { containerEl } = this;
    const { controller } = this.host;
    const { phase } = controller;
    containerEl.empty();
    const account = controller.account();
    new Setting(containerEl)
      .setName("Status")
      .setDesc(
        phase.kind === "removed" || phase.kind === "stopped"
          ? phase.message
          : statusText(phase, controller.lastRound),
      );
    if (account)
      new Setting(containerEl).setName("Account").setDesc(accountName(account));

    const linked = phase.kind === "open" || phase.kind === "opening";
    if (!linked)
      new Setting(containerEl)
        .setName(
          phase.kind === "confirm"
            ? "Confirm the linked account"
            : "Link this vault",
        )
        .setDesc(
          "Approve this vault once in your browser at note.flow.talk. Nothing syncs until you confirm which account it linked to.",
        )
        .addButton((button) =>
          button
            .setButtonText(phase.kind === "confirm" ? "Review" : "Link")
            .setCta()
            .onClick(() => this.host.openLink()),
        );
    if (phase.kind === "stopped")
      new Setting(containerEl).setName("Try again").addButton((button) =>
        button.setButtonText("Retry").onClick(async () => {
          await controller.syncNow();
          this.display();
        }),
      );
    if (linked) {
      new Setting(containerEl)
        .setName("Sync now")
        .setDesc(
          "Syncs both ways now, and asks again about any deletions you held back.",
        )
        .addButton((button) =>
          button.setButtonText("Sync now").onClick(async () => {
            await controller.syncNow();
            this.display();
          }),
        );
      this.roundDetails(containerEl, controller.lastRound);
    }
    if (account || phase.kind === "confirm" || linked)
      new Setting(containerEl)
        .setName("Unlink")
        .setDesc(
          "Stops syncing and forgets this vault's device key and tokens. Your files stay. Remove the device under Access in NOTE too.",
        )
        .addButton((button) =>
          button
            .setButtonText("Unlink")
            .setWarning()
            .onClick(async () => {
              if (
                await confirm(
                  this.app,
                  "Unlink this vault?",
                  "Syncing stops and this vault forgets its device key. Your files stay here and in NOTE.",
                  "Unlink",
                  { warning: true },
                )
              )
                await controller.unlink();
              this.display();
            }),
        );

    const custody = custodyNote(this.app);
    new Setting(containerEl)
      .setName("Device key")
      .setDesc(custody.text)
      .setClass(custody.safe ? "flow-note-safe" : "mod-warning");
  }

  private roundDetails(containerEl: HTMLElement, round: RoundResult | null) {
    if (!round) return;
    const lines = [
      ...round.failed
        .slice(0, 5)
        .map(({ path, error }) => `${path || "Sync"}: ${error}`),
      round.unsyncable.length
        ? `Not synced (a name one side can't store, a name that differs only in case, or an attachment over 32 MB): ${round.unsyncable.slice(0, 5).join(", ")}${round.unsyncable.length > 5 ? "…" : ""}`
        : "",
      round.held.local || round.held.remote
        ? `Held back: ${round.held.local} deletions here and ${round.held.remote} in NOTE. Sync now to review them.`
        : "",
    ].filter(Boolean);
    if (!lines.length) return;
    const details = new Setting(containerEl).setName("Last sync");
    for (const line of lines) details.descEl.createDiv({ text: line });
  }
}
