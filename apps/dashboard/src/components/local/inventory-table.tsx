// SPDX-License-Identifier: Apache-2.0
'use client';
import type { InventoryItem } from '@claude-hub/wss-protocol/messages';
import { Button } from '@/components/ui/button';

export function InventoryTable({
  items,
  onPublish,
}: {
  items: InventoryItem[];
  onPublish: (item: InventoryItem) => void;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No local artifacts found.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2">Type</th>
          <th>Slug</th>
          <th>Version</th>
          <th>Path</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={`${i.type}:${i.slug}`} className="border-b">
            <td className="py-2">{i.type}</td>
            <td>{i.slug}</td>
            <td>{i.version ?? '—'}</td>
            <td className="font-mono text-xs">{i.path}</td>
            <td>
              {i.publishedAs ? (
                <span className="text-muted-foreground">Published as @{i.publishedAs.version}</span>
              ) : (
                <Button size="sm" onClick={() => onPublish(i)}>
                  Publish
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
