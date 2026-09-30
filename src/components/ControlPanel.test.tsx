// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ControlPanel from "./ControlPanel";

afterEach(cleanup);

function panel(permissionDenied: boolean) {
  return (
    <ControlPanel
      open
      unavailable
      permissionDenied={permissionDenied}
      paused={false}
      soundEnabled={false}
      showContent={false}
      checkingAccess={false}
      accessMessage=""
      statusText="Open Claude Desktop."
      onClose={() => undefined}
      onPauseToggle={() => undefined}
      onSoundToggle={() => undefined}
      onShowContentChange={() => undefined}
      onCheckAccess={() => undefined}
      onResetAccess={() => undefined}
    />
  );
}

describe("Bean settings", () => {
  it("offers a permission reset only when Accessibility is denied", () => {
    render(panel(false));
    expect(
      screen.queryByRole("button", { name: /reset permission/i }),
    ).toBeNull();
    cleanup();
    render(panel(true));
    expect(
      screen.getByRole("button", { name: /reset permission/i }),
    ).toBeTruthy();
  });
});
