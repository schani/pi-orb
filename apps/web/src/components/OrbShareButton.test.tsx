import { err, ok } from "neverthrow";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canShareCurrentPage, shareCurrentPage } from "../lib/share-current-page.ts";
import { OrbShareButton } from "./OrbShareButton.tsx";

const hooks = vi.hoisted(() => ({ pending: false, lock: { current: false } }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    hooks.pending,
    (pending: boolean) => {
      hooks.pending = pending;
    },
  ],
  useRef: () => hooks.lock,
}));
vi.mock("../lib/share-current-page.ts", () => ({
  canShareCurrentPage: vi.fn(),
  shareCurrentPage: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  hooks.pending = false;
  hooks.lock.current = false;
  vi.mocked(canShareCurrentPage).mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "labels the action for native capability %s and remains enabled",
  (native) => {
    vi.mocked(canShareCurrentPage).mockReturnValue(native);
    const html = renderToStaticMarkup(<OrbShareButton onNotice={() => {}} />);
    const label = native ? "Share current page" : "Copy link";
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain('type="button"');
    expect(html).toContain('href="#i-share"');
    expect(html).not.toContain("disabled");
  },
);

it("starts sharing in the click stack and guards repeat clicks until settlement", async () => {
  let settle = (_result: Awaited<ReturnType<typeof shareCurrentPage>>) => {};
  vi.mocked(shareCurrentPage).mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  const onNotice = vi.fn();
  const button = OrbShareButton({ onNotice });
  const first = button.props.onClick();
  expect(shareCurrentPage).toHaveBeenCalledOnce();
  expect(hooks.pending).toBe(true);
  expect(renderToStaticMarkup(<OrbShareButton onNotice={onNotice} />)).toContain('disabled=""');
  await button.props.onClick();
  expect(shareCurrentPage).toHaveBeenCalledOnce();
  settle(ok("copied"));
  await first;
  expect(hooks.pending).toBe(false);
  expect(onNotice).toHaveBeenLastCalledWith({ message: "Link copied.", error: false });
  vi.mocked(shareCurrentPage).mockResolvedValue(ok("shared"));
  await button.props.onClick();
  expect(shareCurrentPage).toHaveBeenCalledTimes(2);
});

it.each(["shared", "cancelled"] as const)("keeps %s quiet", async (outcome) => {
  vi.mocked(shareCurrentPage).mockResolvedValue(ok(outcome));
  const onNotice = vi.fn();
  await OrbShareButton({ onNotice }).props.onClick();
  expect(onNotice.mock.calls).toEqual([[null]]);
  expect(hooks.lock.current).toBe(false);
});

it.each([
  ["share_failed", "Couldn't share this page."],
  ["clipboard_unavailable", "Couldn't copy link."],
] as const)("surfaces %s with content-free debug output", async (type, message) => {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.mocked(shareCurrentPage).mockResolvedValue(err({ type }));
  const onNotice = vi.fn();
  await OrbShareButton({ onNotice }).props.onClick();
  expect(onNotice).toHaveBeenLastCalledWith({ message, error: true });
  expect(debug).toHaveBeenCalledWith("page share failed", { type });
  expect(hooks.lock.current).toBe(false);
});
