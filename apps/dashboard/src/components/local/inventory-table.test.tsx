// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InventoryTable } from './inventory-table';

describe('InventoryTable', () => {
  it('renders rows for each item with Publish action when not published', () => {
    const onPublish = vi.fn();
    render(
      <InventoryTable
        items={[
          { type: 'skill', slug: 'foo', version: null, path: '/x', enabled: null },
          {
            type: 'skill',
            slug: 'bar',
            version: '0.1.0',
            path: '/y',
            enabled: null,
            publishedAs: { artifactId: 'a-1', version: '0.1.0' },
          },
        ]}
        onPublish={onPublish}
      />,
    );
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
    const publishBtns = screen.getAllByRole('button', { name: /publish/i });
    expect(publishBtns).toHaveLength(1);
    fireEvent.click(publishBtns[0]!);
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ slug: 'foo' }));
  });

  it('shows empty state when no items', () => {
    render(<InventoryTable items={[]} onPublish={() => {}} />);
    expect(screen.getByText(/no local artifacts/i)).toBeInTheDocument();
  });
});
