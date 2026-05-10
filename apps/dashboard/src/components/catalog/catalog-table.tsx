// SPDX-License-Identifier: Apache-2.0
'use client';
import Link from 'next/link';

export type CatalogRow = {
  id: string;
  slug: string;
  type: string;
  description: string;
  latestVersion: string | null;
};

export function CatalogTable({ items }: { items: CatalogRow[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">No artifacts published yet.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2">Slug</th>
          <th>Type</th>
          <th>Description</th>
          <th>Latest version</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} className="border-b hover:bg-muted/40">
            <td className="py-2">
              <Link href={`/catalog/${i.slug}`} className="underline">
                {i.slug}
              </Link>
            </td>
            <td>{i.type}</td>
            <td>{i.description}</td>
            <td>{i.latestVersion ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
