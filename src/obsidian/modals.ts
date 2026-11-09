import { type App, Modal, Notice, Setting } from "obsidian";
import { handleDomain, type LinkedAccount } from "../account";
import type { SyncController } from "../controller";
import type { LinkPrompt } from "../device";

/** Where approving a link happens; a verification address anywhere else is shown, never opened. */
export const NOTE_ORIGIN = "https://note.flow.talk";

const linkPage = (prompt: LinkPrompt) => {
  try {
    const url = new URL(prompt.verificationUri);
    return url.origin === NOTE_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
};

async function copyLink(page: string) {
  try {
    await navigator.clipboard.writeText(page);
    new Notice("Link copied. Open it in the browser where you use NOTE.");
  } catch {
    new Notice(
      `Couldn't copy the link. Open ${page} in the browser where you use NOTE.`,
      0,
    );
  }
}

/** Asks a yes-or-no question; closing the modal answers no. */
export function confirm(
  app: App,
  title: string,
  message: string,
  yes: string,
  options: { warning?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new Modal(app);
    modal.setTitle(title);
    modal.contentEl.createEl("p", { text: message });
    new Setting(modal.contentEl)
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => modal.close()),
      )
      .addButton((button) => {
        button.setButtonText(yes).onClick(() => {
          answered = true;
          modal.close();
        });
        if (options.warning) button.setWarning();
        else button.setCta();
      });
    modal.onClose = () => resolve(answered);
    modal.open();
  });
}

export function accountName(account: LinkedAccount): string {
  return account.handle ? `@${account.handle} (${account.did})` : account.did;
}

/**
 * Links this vault: asks for a label, shows the codes while the person
 * approves in their browser, then asks them to confirm the account before
 * anything syncs.
 */
export class LinkModal extends Modal {
  private abort: AbortController | null = null;
  private label: string;
  private error: string | null = null;
  private opened = false;

  constructor(
    app: App,
    private readonly controller: SyncController,
    label: string,
    private readonly beforeLink: () => Promise<boolean>,
  ) {
    super(app);
    this.label = label;
    this.setTitle("Link to NOTE");
  }

  override onOpen() {
    this.render();
  }

  override onClose() {
    this.abort?.abort(new Error("Linking was cancelled."));
    this.contentEl.empty();
  }

  /** Redraws for the controller's current phase. */
  render() {
    const { contentEl } = this;
    const { phase } = this.controller;
    contentEl.empty();
    if (this.error)
      contentEl.createEl("p", { cls: "mod-warning", text: this.error });
    if (phase.kind === "linking") return this.renderPrompt(phase.prompt);
    if (phase.kind === "confirm") return this.renderConfirm(phase.account);
    if (phase.kind === "open" || phase.kind === "opening") {
      contentEl.createEl("p", { text: "This vault is linked and syncing." });
      return;
    }
    if (phase.kind === "stopped") {
      contentEl.createEl("p", {
        text: `This vault is still linked, but syncing stopped: ${phase.message} Retry from this plugin's settings, or unlink the vault there before linking it again.`,
      });
      return;
    }
    contentEl.createEl("p", {
      text: "This vault becomes a device on your NOTE notepad. You approve it once in your browser; after that it syncs without asking for your passkey.",
    });
    new Setting(contentEl)
      .setName("Device name")
      .setDesc("Shown under Access in NOTE.")
      .addText((text) =>
        text.setValue(this.label).onChange((value) => {
          this.label = value;
        }),
      );
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Link")
        .setCta()
        .onClick(() => void this.link()),
    );
  }

  private renderPrompt(prompt: LinkPrompt | undefined) {
    const { contentEl } = this;
    if (!prompt) {
      contentEl.createEl("p", { text: "Asking Flow ID for a code…" });
      return;
    }
    const page = linkPage(prompt);
    if (page && !this.opened) {
      this.opened = true;
      window.open(page);
    }
    contentEl.createEl("p", {
      text: page
        ? "NOTE's link page opened in your default browser. Approve from the browser where you use NOTE: if that's another browser or profile, copy the link and open it there. Sign in if asked, check the Flow ID code matches, and type the device code below."
        : `Open ${NOTE_ORIGIN}/link in the browser where you use NOTE, enter the Flow ID code below, and type the device code.`,
    });
    new Setting(contentEl).setName("Flow ID code").setDesc(prompt.userCode);
    const secret = new Setting(contentEl)
      .setName("Device code")
      .setDesc(
        "Type it on the link page. Never send it to anyone: it proves this vault is the device you approve.",
      );
    secret.controlEl.createSpan({
      cls: "flow-note-code",
      text: prompt.pairingCode,
    });
    const row = new Setting(contentEl);
    if (page)
      row
        .addButton((button) =>
          button.setButtonText("Copy link").onClick(() => void copyLink(page)),
        )
        .addButton((button) =>
          button
            .setButtonText("Open link page again")
            .onClick(() => window.open(page)),
        );
    row.addButton((button) =>
      button.setButtonText("Cancel").onClick(() => this.close()),
    );
  }

  private renderConfirm(account: LinkedAccount) {
    const { contentEl } = this;
    contentEl.createEl("p", { text: "This vault is linked to this account:" });
    if (account.handle)
      new Setting(contentEl)
        .setName(`@${account.handle}`)
        .setDesc(`Vouched for by the domain ${handleDomain(account.handle)}`);
    new Setting(contentEl).setName("DID").setDesc(account.did);
    contentEl.createEl("p", {
      text: account.handle
        ? "Your notes will sync with this account's NOTE notepad. Check it is the account NOTE shows you, and that you know the domain: a handle under a domain you don't, however close it looks, isn't yours."
        : "The account's handle couldn't be confirmed, so this is its DID. Check it is the account NOTE shows you: your notes will sync with this account's NOTE notepad.",
    });
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("This isn't my account")
          .setWarning()
          .onClick(async () => {
            await this.controller.unlink();
            new Notice(
              "Unlinked. Remove this device under Access in NOTE, in the account it was linked to, if you can.",
              0,
            );
            this.close();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Start syncing")
          .setCta()
          .onClick(async () => {
            this.close();
            await this.controller.confirm();
          }),
      );
  }

  private async link() {
    if (!(await this.beforeLink())) return;
    this.error = null;
    this.abort = new AbortController();
    try {
      await this.controller.link(
        this.label.trim() || "Obsidian",
        this.abort.signal,
      );
    } catch (error) {
      if (!this.abort.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.abort = null;
      this.render();
    }
  }
}
