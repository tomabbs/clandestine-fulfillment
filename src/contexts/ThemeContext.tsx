"use client";

import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes";
import { createContext, useContext } from "react";

type ThemeValue = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: ThemeValue;
  resolvedTheme: "light" | "dark";
  setTheme: (theme: ThemeValue) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

function ThemeContextBridge({ children }: { children: React.ReactNode }) {
  const { theme, resolvedTheme, setTheme } = useNextTheme();

  const value: ThemeContextValue = {
    theme: (theme as ThemeValue) ?? "system",
    resolvedTheme: (resolvedTheme as "light" | "dark") ?? "light",
    setTheme,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="theme-preference"
      disableTransitionOnChange
    >
      <ThemeContextBridge>{children}</ThemeContextBridge>
    </NextThemesProvider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
