"use client";

import { useState } from "react";
import { getDiscogsCredentials, saveDiscogsCredentials } from "@/actions/discogs-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

export default function DiscogsCredentialsPage() {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");

  const { data, isLoading } = useAppQuery({
    queryKey: ["discogs", "credentials"],
    queryFn: () => getDiscogsCredentials(),
    tier: CACHE_TIERS.SESSION,
  });

  const saveMut = useAppMutation({
    mutationFn: () => saveDiscogsCredentials({ accessToken: token, username }),
    invalidateKeys: [["discogs"]],
    onSuccess: () => {
      setToken("");
      setUsername("");
    },
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Discogs Credentials</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Personal Access Token for the Clandestine Discogs master catalog account.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current Connection</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : data?.credentials ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="default">Connected</Badge>
                <span className="font-mono">@{data.credentials.username}</span>
              </div>
              <p className="text-muted-foreground">
                Last updated: {new Date(data.credentials.updated_at).toLocaleDateString()}
              </p>
            </div>
          ) : (
            <Badge variant="outline">Not configured</Badge>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Set Personal Access Token</CardTitle>
          <CardDescription>
            Generate a token at{" "}
            <a
              href="https://www.discogs.com/settings/developers"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              discogs.com/settings/developers
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor="discogs-username" className="text-sm font-medium block mb-1">
              Discogs Username
            </label>
            <Input
              id="discogs-username"
              placeholder="your_discogs_username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <label htmlFor="discogs-token" className="text-sm font-medium block mb-1">
              Personal Access Token
            </label>
            <Input
              id="discogs-token"
              type="password"
              placeholder="Enter token…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono"
            />
          </div>
          <Button
            disabled={!token || !username || saveMut.isPending}
            onClick={() => saveMut.mutate()}
          >
            {saveMut.isPending ? "Saving…" : "Save Credentials"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
