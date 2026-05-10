// SPDX-License-Identifier: Apache-2.0
'use client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CatalogTable, type CatalogRow } from '@/components/catalog/catalog-table';
import { useDebounce } from '@/lib/use-debounce';

const queryClient = new QueryClient();

type TypeFilter = 'all' | 'skill' | 'plugin' | 'command' | 'agent';

interface CatalogResponse {
  items: CatalogRow[];
  page: number;
  limit: number;
  total: number;
}

async function listArtifacts(type: TypeFilter, q: string): Promise<CatalogResponse> {
  const params = new URLSearchParams();
  if (type !== 'all') params.set('type', type);
  if (q) params.set('q', q);
  const res = await fetch(`/api/artifacts?${params.toString()}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`listArtifacts: ${res.status}`);
  return (await res.json()) as CatalogResponse;
}

function CatalogPageInner() {
  const [type, setType] = useState<TypeFilter>('all');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q, 300);

  const query = useQuery({
    queryKey: ['catalog', type, debouncedQ],
    queryFn: () => listArtifacts(type, debouncedQ),
  });

  return (
    <main className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">Catalog</h1>
      <div className="flex items-center gap-3">
        <div className="w-40">
          <Select value={type} onValueChange={(v) => setType(v as TypeFilter)}>
            <SelectTrigger>
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="skill">Skill</SelectItem>
              <SelectItem value="plugin">Plugin</SelectItem>
              <SelectItem value="command">Command</SelectItem>
              <SelectItem value="agent">Agent</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Input
          placeholder="Search description"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm"
        />
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p className="text-sm text-red-600">Failed to load catalog.</p>
      ) : (
        <CatalogTable items={query.data?.items ?? []} />
      )}
    </main>
  );
}

export default function CatalogPage() {
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogPageInner />
    </QueryClientProvider>
  );
}
