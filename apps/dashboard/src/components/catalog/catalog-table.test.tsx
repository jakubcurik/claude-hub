// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CatalogTable } from './catalog-table';

describe('CatalogTable', () => {
  it('renders rows for each artifact', () => {
    render(
      <CatalogTable
        items={[
          { id: 'a-1', slug: 'foo', type: 'skill', description: 'desc', latestVersion: '0.1.0' },
          { id: 'a-2', slug: 'bar', type: 'plugin', description: 'plug', latestVersion: null },
        ]}
      />,
    );
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    render(<CatalogTable items={[]} />);
    expect(screen.getByText(/no artifacts published/i)).toBeInTheDocument();
  });
});
