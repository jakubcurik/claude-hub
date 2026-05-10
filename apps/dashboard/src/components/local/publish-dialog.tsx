// SPDX-License-Identifier: Apache-2.0
'use client';
import { useEffect, useState } from 'react';
import type { InventoryItem } from '@claude-hub/wss-protocol/messages';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

interface Props {
  daemonId: string;
  item: InventoryItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPublished?: () => void;
}

export function PublishDialog({ daemonId, item, open, onOpenChange, onPublished }: Props) {
  const [version, setVersion] = useState('0.1.0');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (item) {
      setVersion(item.version ?? '0.1.0');
      setDescription('');
    }
  }, [item]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('no item');
      const res = await fetch(`/api/local/${daemonId}/publish-request`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: item.slug,
          type: item.type,
          version,
          description,
          sourcePath: item.path,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(err.message ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as Record<string, unknown>;
    },
    onSuccess: () => {
      onPublished?.();
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Publish artifact</DialogTitle>
        <DialogDescription>
          Package and publish <span className="font-mono">{item?.slug ?? ''}</span> from this
          daemon.
        </DialogDescription>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <Label htmlFor="publish-version">Version</Label>
            <Input
              id="publish-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="0.1.0"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="publish-description">Description</Label>
            <Input
              id="publish-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description"
            />
          </div>
          {mutation.error && (
            <p className="text-sm text-red-600">{(mutation.error as Error).message}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !description.trim()}
          >
            {mutation.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
