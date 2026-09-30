/**
 * pi's stock footer with the `• <session name>` suffix suppressed: the session
 * title is redundant there because tmux already names the window from the
 * terminal title. Everything else (branch, token stats, context, model) is the
 * real built-in footer reading live state through the stub session.
 */

import { type ReadonlyFooterDataProvider, FooterComponent } from "@earendil-works/pi-coding-agent";

export class QuietFooter extends FooterComponent {
	constructor(footerData: ReadonlyFooterDataProvider, stub: unknown) {
		super(stub as never, footerData);
	}

	/** Ignore pi swapping in the real session, which would re-add the name. */
	override setSession(): void {}
}
