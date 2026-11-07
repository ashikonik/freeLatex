import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ShareModal } from './ShareModal.js';

const createShareToken = vi.hoisted(() => vi.fn());
const listShareTokens = vi.hoisted(() => vi.fn());
const revokeShareToken = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api.js', () => ({ createShareToken, listShareTokens, revokeShareToken }));

const TOKENS = [
  {
    id: 'tok_1',
    label: 'For the adviser',
    permission: 'ro' as const,
    createdAt: '2026-11-07T10:00:00.000Z',
    expiresAt: null,
    expired: false,
  },
];

beforeEach(() => {
  createShareToken
    .mockReset()
    .mockResolvedValue({ id: 'tok_2', url: '/share/ro_abcdef', permission: 'ro' });
  listShareTokens.mockReset().mockResolvedValue({ tokens: TOKENS });
  revokeShareToken.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the share links of a project', () => {
  it('lists the links that already exist', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('For the adviser')).toBeInTheDocument());
    expect(screen.getByTestId('token-list')).toBeInTheDocument();
  });

  it('creates a read-only link by default', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('create-link-button')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('create-link-button'));

    await waitFor(() => expect(createShareToken).toHaveBeenCalledTimes(1));
    expect(createShareToken.mock.calls[0]?.[1]).toMatchObject({ permission: 'ro' });
  });

  it('creates a link that may edit', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('share-permission')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('share-permission'), { target: { value: 'rw' } });
    fireEvent.click(screen.getByTestId('create-link-button'));

    await waitFor(() => expect(createShareToken).toHaveBeenCalledTimes(1));
    expect(createShareToken.mock.calls[0]?.[1]).toMatchObject({ permission: 'rw' });
  });

  it('shows the new link once', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('create-link-button')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('create-link-button'));

    await waitFor(() => expect(screen.getByTestId('created-link')).toBeInTheDocument());
    expect(screen.getByTestId('created-link')).toHaveTextContent('/share/ro_abcdef');
  });

  it('revokes a link', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('For the adviser')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Revoke For the adviser' }));

    await waitFor(() => expect(revokeShareToken).toHaveBeenCalledWith('prj_1', 'tok_1'));
  });

  it('reports a link that could not be created', async () => {
    createShareToken.mockRejectedValue(new Error('The share link could not be created.'));
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('create-link-button')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('create-link-button'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('The share link could not be created.'),
    );
  });

  it('says when the project has no link yet', async () => {
    listShareTokens.mockResolvedValue({ tokens: [] });
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeInTheDocument());
  });

  it('gives a link an expiry when days are asked for', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('share-expires-in')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('share-expires-in'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('create-link-button'));

    await waitFor(() => expect(createShareToken).toHaveBeenCalledTimes(1));
    const options = createShareToken.mock.calls[0]?.[1] as { expiresAt?: string };
    expect(options.expiresAt).toBeDefined();
    const expiry = new Date(options.expiresAt as string).getTime();
    const sevenDays = 7 * 86_400_000;
    expect(Math.abs(expiry - (Date.now() + sevenDays))).toBeLessThan(10_000);
  });

  it('refuses an expiry that is not a whole number of days', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('share-expires-in')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('share-expires-in'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByTestId('create-link-button'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('whole number of days'));
    expect(createShareToken).not.toHaveBeenCalled();
  });

  it('refuses an expiry of less than a day', async () => {
    render(<ShareModal projectId="prj_1" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('share-expires-in')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('share-expires-in'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('create-link-button'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('whole number of days'));
    expect(createShareToken).not.toHaveBeenCalled();
  });

  it('closes when the reader presses Escape', () => {
    const onClose = vi.fn();

    render(<ShareModal projectId="prj_1" onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
