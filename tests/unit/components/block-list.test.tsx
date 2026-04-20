import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { BlockList } from "@/components/shared/block-list";

interface Row {
  id: string;
  title: string;
}

const ROWS: Row[] = [
  { id: "r1", title: "First" },
  { id: "r2", title: "Second" },
  { id: "r3", title: "Third" },
];

function renderList(overrides?: Partial<ComponentProps<typeof BlockList<Row>>>) {
  return render(
    <BlockList<Row>
      items={ROWS}
      itemKey={(row) => row.id}
      renderHeader={({ row }) => <p>{row.title}</p>}
      renderBody={({ row }) => <p>Body {row.id}</p>}
      virtualizeThreshold={9999}
      {...overrides}
    />,
  );
}

describe("BlockList", () => {
  it("renders rows", () => {
    renderList();
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.getByText("Third")).toBeTruthy();
  });

  it("supports uncontrolled selection and shift range selection", () => {
    renderList({ selectable: true });

    const first = screen.getByLabelText("Select row r1");
    const third = screen.getByLabelText("Select row r3");

    fireEvent.click(first);
    fireEvent.click(third, { shiftKey: true });

    expect((screen.getByLabelText("Select row r1") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select row r2") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select row r3") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("3 selected of 3")).toBeTruthy();
  });

  it("supports controlled selection", () => {
    const onSelectedKeysChange = vi.fn();
    const selected = new Set<string | number>(["r2"]);
    renderList({
      selectable: true,
      selectedKeys: selected,
      onSelectedKeysChange,
    });

    const first = screen.getByLabelText("Select row r1");
    fireEvent.click(first);

    expect(onSelectedKeysChange).toHaveBeenCalledTimes(1);
    const call = onSelectedKeysChange.mock.calls[0]?.[0] as Set<string | number>;
    expect(call.has("r1")).toBe(true);
    expect(call.has("r2")).toBe(true);
  });

  it("toggles expanded content", () => {
    renderList({
      renderActions: ({ toggleExpanded }) => (
        <button type="button" onClick={() => toggleExpanded()}>
          Toggle
        </button>
      ),
      renderExpanded: ({ row }) => <div>{`Expanded ${row.id}`}</div>,
    });

    const row = screen.getByText("First").closest("li");
    expect(row).toBeTruthy();
    if (!row) return;

    fireEvent.click(screen.getAllByText("Toggle")[0]);
    expect(screen.getByText("Expanded r1")).toBeTruthy();
  });

  it("shows global action error when row action fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });

    renderList({
      renderActions: ({ actionContext }) => (
        <button type="button" onClick={() => actionContext.runAction("fail", failing)}>
          Fail action
        </button>
      ),
    });

    fireEvent.click(screen.getAllByText("Fail action")[0]);

    await screen.findByText("Action failed");
    expect(screen.getByText("boom")).toBeTruthy();
  });
});
