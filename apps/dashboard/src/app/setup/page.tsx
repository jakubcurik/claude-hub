// SPDX-License-Identifier: Apache-2.0
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setupAction } from './actions';

async function getStatus(): Promise<{ needsSetup: boolean }> {
  const base = process.env.HUB_SERVER_URL ?? 'http://localhost:3000';
  const res = await fetch(`${base}/api/setup/status`, { cache: 'no-store' });
  if (!res.ok) return { needsSetup: false };
  return res.json() as Promise<{ needsSetup: boolean }>;
}

export default async function SetupPage() {
  const { needsSetup } = await getStatus();
  if (!needsSetup) {
    redirect('/login');
  }
  return (
    <main className="container mx-auto max-w-sm p-8">
      <h1 className="mb-2 text-2xl font-semibold">Welcome to Claude Hub</h1>
      <p className="mb-6 text-sm text-slate-600">Create the root admin account to continue.</p>
      <form action={setupAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password (min 12 chars)</Label>
          <Input id="password" name="password" type="password" required minLength={12} />
        </div>
        <Button type="submit" className="w-full">
          Create admin
        </Button>
      </form>
    </main>
  );
}
