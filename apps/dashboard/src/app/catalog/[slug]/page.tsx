// SPDX-License-Identifier: Apache-2.0
'use client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ArtifactDTO, ArtifactVersionDTO, DaemonDTO } from '@claude-hub/shared-types';
import { listDaemons } from '@/lib/api/daemons';
import { InstallButton } from '@/components/catalog/install-button';

const queryClient = new QueryClient();

interface ArtifactDetailResponse {
  artifact: ArtifactDTO;
  versions: ArtifactVersionDTO[];
}

async function getArtifact(slug: string): Promise<ArtifactDetailResponse> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`getArtifact: ${res.status}`);
  return (await res.json()) as ArtifactDetailResponse;
}

function CatalogDetailInner({ slug }: { slug: string }) {
  const artifactQuery = useQuery({
    queryKey: ['artifact', slug],
    queryFn: () => getArtifact(slug),
  });
  const daemonsQuery = useQuery({ queryKey: ['daemons'], queryFn: listDaemons });

  if (artifactQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (artifactQuery.isError || !artifactQuery.data) {
    return <p className="text-sm text-red-600">Failed to load artifact.</p>;
  }

  const { artifact, versions } = artifactQuery.data;
  const latest = versions[0];
  const daemons: DaemonDTO[] = daemonsQuery.data ?? [];
  const onlineDaemon = daemons.find((d) => d.online);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{artifact.slug}</h1>
        <p className="text-sm text-muted-foreground">
          {artifact.type} · {artifact.description}
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Versions</h2>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions published yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2">Version</th>
                <th>Published</th>
                <th>SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className="border-b">
                  <td className="py-2">{v.version}</td>
                  <td>{new Date(v.publishedAt).toLocaleString()}</td>
                  <td className="font-mono text-xs">{v.sha256.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Install</h2>
        {!latest ? (
          <p className="text-sm text-muted-foreground">No version available to install.</p>
        ) : !onlineDaemon ? (
          <p className="text-sm text-muted-foreground">No online daemon available.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Target daemon: {onlineDaemon.hostname} ({onlineDaemon.os}) · version {latest.version}
            </p>
            <InstallButton
              artifactId={artifact.id}
              version={latest.version}
              daemonId={onlineDaemon.id}
            />
          </>
        )}
      </section>
    </div>
  );
}

export default function CatalogDetailPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  return (
    <QueryClientProvider client={queryClient}>
      <main className="space-y-4 p-6">
        <CatalogDetailInner slug={slug} />
      </main>
    </QueryClientProvider>
  );
}
