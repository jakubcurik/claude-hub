// SPDX-License-Identifier: Apache-2.0
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { registerAction } from './actions';

export default function RegisterPage() {
  return (
    <main className="container mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-semibold">Create account</h1>
      <form action={registerAction} className="space-y-4">
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
          Register
        </Button>
      </form>
    </main>
  );
}
