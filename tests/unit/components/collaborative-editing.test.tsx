import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FieldEditIndicator,
  PresenceDots,
  RemoteChangeNotification,
} from "@/components/shared/collaborative-editing";

describe("FieldEditIndicator", () => {
  it("renders children without indicator when not being edited", () => {
    render(
      <FieldEditIndicator fieldName="title" isBeingEdited={false} editor={null}>
        <input data-testid="field" />
      </FieldEditIndicator>,
    );

    expect(screen.getByTestId("field")).toBeTruthy();
    expect(screen.queryByText(/is editing/)).toBeNull();
  });

  it("shows editor name when field is being edited", () => {
    const editor = {
      userId: "user-bob",
      userName: "Bob",
      editingField: "title",
      joinedAt: "2025-01-01",
    };

    render(
      <FieldEditIndicator fieldName="title" isBeingEdited={true} editor={editor}>
        <input data-testid="field" />
      </FieldEditIndicator>,
    );

    expect(screen.getByText("Bob is editing...")).toBeTruthy();
    expect(screen.getByTestId("field")).toBeTruthy();
  });
});

describe("RemoteChangeNotification", () => {
  it("renders nothing when no changes", () => {
    const { container } = render(<RemoteChangeNotification changes={[]} onDismiss={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows latest change details", () => {
    const changes = [
      {
        userId: "user-bob",
        userName: "Bob",
        savedFields: ["title", "price"],
        timestamp: "2025-01-01T12:00:00Z",
      },
    ];

    render(<RemoteChangeNotification changes={changes} onDismiss={vi.fn()} />);

    expect(screen.getByText("Bob saved changes")).toBeTruthy();
    expect(screen.getByText("Updated: title, price")).toBeTruthy();
  });

  it("shows overflow count for multiple changes", () => {
    const changes = [
      {
        userId: "user-bob",
        userName: "Bob",
        savedFields: ["title"],
        timestamp: "2025-01-01T12:00:00Z",
      },
      {
        userId: "user-carol",
        userName: "Carol",
        savedFields: ["price"],
        timestamp: "2025-01-01T12:01:00Z",
      },
      {
        userId: "user-dave",
        userName: "Dave",
        savedFields: ["sku"],
        timestamp: "2025-01-01T12:02:00Z",
      },
    ];

    render(<RemoteChangeNotification changes={changes} onDismiss={vi.fn()} />);

    // Shows latest
    expect(screen.getByText("Dave saved changes")).toBeTruthy();
    // Shows overflow
    expect(screen.getByText("+2 more updates")).toBeTruthy();
  });

  it("calls onDismiss when close button is clicked", () => {
    const onDismiss = vi.fn();
    const changes = [
      {
        userId: "user-bob",
        userName: "Bob",
        savedFields: ["title"],
        timestamp: "2025-01-01T12:00:00Z",
      },
    ];

    render(<RemoteChangeNotification changes={changes} onDismiss={onDismiss} />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("PresenceDots", () => {
  it("renders nothing when no editors", () => {
    const { container } = render(<PresenceDots editors={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders dots with names for each editor", () => {
    const editors = [
      { userId: "user-1", userName: "Alice", editingField: "title", joinedAt: "2025-01-01" },
      { userId: "user-2", userName: "Bob", editingField: "price", joinedAt: "2025-01-01" },
    ];

    render(<PresenceDots editors={editors} />);

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });
});
