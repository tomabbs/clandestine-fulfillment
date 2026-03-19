"use client";

import { Loader2, Plus, Search, UserPlus } from "lucide-react";
import { useState } from "react";
import {
  deactivateUser,
  getUsers,
  inviteUser,
  updateUserRole,
} from "@/actions/users";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppMutation, useAppQuery } from "@/lib/hooks/use-app-query";
import { CACHE_TIERS } from "@/lib/shared/query-tiers";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  super_admin: "Super Admin",
  label_staff: "Label Staff",
  label_management: "Label Mgmt",
  warehouse_manager: "Warehouse Mgr",
  client: "Client",
  client_admin: "Client Admin",
};

const STAFF_ROLE_OPTIONS = [
  { value: "admin", label: "Admin" },
  { value: "super_admin", label: "Super Admin" },
  { value: "label_staff", label: "Label Staff" },
  { value: "label_management", label: "Label Management" },
  { value: "warehouse_manager", label: "Warehouse Manager" },
];

const ALL_ROLE_OPTIONS = [
  ...STAFF_ROLE_OPTIONS,
  { value: "client", label: "Client" },
  { value: "client_admin", label: "Client Admin" },
];

const USER_QUERY_KEY = ["admin", "settings", "users"] as const;

export default function UsersPage() {
  const [search, setSearch] = useState("");

  const { data: users, isLoading } = useAppQuery({
    queryKey: [...USER_QUERY_KEY, search],
    queryFn: () => getUsers({ search: search || undefined }),
    tier: CACHE_TIERS.SESSION,
  });

  const roleMut = useAppMutation({
    mutationFn: (vars: { userId: string; role: string }) => updateUserRole(vars),
    invalidateKeys: [USER_QUERY_KEY],
  });

  const deactivateMut = useAppMutation({
    mutationFn: (vars: { userId: string }) => deactivateUser(vars),
    invalidateKeys: [USER_QUERY_KEY],
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">User Management</h1>
        <InviteDialog />
      </div>

      <div className="flex items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading users...
        </div>
      ) : !users || users.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No users found.
          </CardContent>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.name ?? "-"}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell>
                  <Select
                    value={user.role}
                    onValueChange={(role) => {
                      if (role) roleMut.mutate({ userId: user.id, role });
                    }}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALL_ROLE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Badge variant={user.is_active ? "default" : "destructive"}>
                    {user.is_active ? "Active" : "Deactivated"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {new Date(user.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => deactivateMut.mutate({ userId: user.id })}
                    disabled={deactivateMut.isPending}
                  >
                    {user.is_active ? "Deactivate" : "Reactivate"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("label_staff");

  const inviteMut = useAppMutation({
    mutationFn: (vars: { email: string; name: string; role: string }) =>
      inviteUser({ email: vars.email, name: vars.name, role: vars.role as never }),
    invalidateKeys: [USER_QUERY_KEY],
    onSuccess: () => {
      setOpen(false);
      setEmail("");
      setName("");
      setRole("label_staff");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <UserPlus className="h-4 w-4 mr-2" />
            Invite User
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite New User</DialogTitle>
          <DialogDescription>
            Send an email invitation. The user will be able to log in after accepting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="invite-name">Name</Label>
            <Input
              id="invite-name"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => { if (v) setRole(v); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAFF_ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {inviteMut.error && (
            <p className="text-sm text-destructive">{(inviteMut.error as Error).message}</p>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            onClick={() => inviteMut.mutate({ email, name, role })}
            disabled={!email || !name || inviteMut.isPending}
          >
            {inviteMut.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Sending...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-1" /> Send Invite
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
