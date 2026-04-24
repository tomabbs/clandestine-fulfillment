import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

import { SafetyStockInput } from "@/app/admin/settings/safety-stock/_components/safety-stock-input";

describe("SafetyStockInput", () => {
  it("stages a valid inline change before blur", () => {
    const onCommit = vi.fn();

    render(<SafetyStockInput value={0} isDirty={false} onCommit={onCommit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "1" } });

    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it("does not stage an invalid inline value", () => {
    const onCommit = vi.fn();

    render(<SafetyStockInput value={0} isDirty={false} onCommit={onCommit} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } });

    expect(onCommit).not.toHaveBeenCalled();
  });
});
