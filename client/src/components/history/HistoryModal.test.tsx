import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { HistoryModal } from './HistoryModal.js';

const listSnapshots = vi.hoisted(() => vi.fn());
const diffSnapshot = vi.hoisted(() => vi.fn());
const rollbackToSnapshot = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api.js', () => ({ listSnapshots, diffSnapshot, rollbackToSnapshot }));

const SNAPSHOTS = [
  { id: 'snap_2', label: 'Second draft', fileCount: 2, createdAt: '2026-11-07T10:00:00.000Z' },
  { id: 'snap_1', label: 'First draft', fileCount: 1, createdAt: '2026-11-06T10:00:00.000Z' },
];

beforeEach(() => {
  listSnapshots.mockReset().mockResolvedValue({ snapshots: SNAPSHOTS });
  diffSnapshot.mockReset().mockResolvedValue({
    from: 'snap_2',
    to: 'snap_2',
    diffs: [{ path: 'main.tex', patch: '-old\n+new\n', addedLines: 1, removedLines: 1 }],
  });
  rollbackToSnapshot.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the document history', () => {
  it('lists the revisions of the project', async () => {
    render(<HistoryModal projectId="prj_1" onClose={vi.fn()} onRestored={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Second draft')).toBeInTheDocument());
    expect(screen.getByText('First draft')).toBeInTheDocument();
  });

  it('shows the difference of the newest revision', async () => {
    render(<HistoryModal projectId="prj_1" onClose={vi.fn()} onRestored={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('diff-file')).toBeInTheDocument());
    expect(screen.getByTestId('diff-file')).toHaveTextContent('main.tex');
  });

  it('asks for the difference of the revision that is picked', async () => {
    render(<HistoryModal projectId="prj_1" onClose={vi.fn()} onRestored={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument());
    fireEvent.click(screen.getByText('First draft'));

    await waitFor(() => expect(diffSnapshot).toHaveBeenCalledWith('prj_1', 'snap_1'));
  });

  it('restores the project to the revision that is picked', async () => {
    const onRestored = vi.fn();
    const onClose = vi.fn();
    render(<HistoryModal projectId="prj_1" onClose={onClose} onRestored={onRestored} />);

    await waitFor(() => expect(screen.getByText('First draft')).toBeInTheDocument());
    fireEvent.click(screen.getByText('First draft'));
    await waitFor(() => expect(diffSnapshot).toHaveBeenCalledWith('prj_1', 'snap_1'));

    fireEvent.click(screen.getByTestId('restore-button'));

    await waitFor(() => expect(rollbackToSnapshot).toHaveBeenCalledWith('prj_1', 'snap_1'));
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports a restore that failed', async () => {
    rollbackToSnapshot.mockRejectedValue(new Error('The restore failed.'));
    render(<HistoryModal projectId="prj_1" onClose={vi.fn()} onRestored={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('restore-button')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('restore-button'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The restore failed.'));
  });

  it('says when there is no revision yet', async () => {
    listSnapshots.mockResolvedValue({ snapshots: [] });
    render(<HistoryModal projectId="prj_1" onClose={vi.fn()} onRestored={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('No revisions yet.')).toBeInTheDocument());
  });

  it('says which revision the difference is against', async () => {
    render(<HistoryModal projectId="prj_1" onClose={vi.fn()} onRestored={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('diff-file')).toBeInTheDocument());
    expect(screen.getByText(/Comparing this revision with/)).toHaveTextContent('Second draft');
  });

  it('shows a changed line next to its replacement', async () => {
    render(<HistoryModal projectId="prj_1" onClose={vi.fn()} onRestored={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('diff-file')).toBeInTheDocument());
    const file = screen.getByTestId('diff-file');
    expect(file).toHaveTextContent('old');
    expect(file).toHaveTextContent('new');
  });

  it('closes when the reader presses Escape', () => {
    const onClose = vi.fn();

    render(<HistoryModal projectId="prj_1" onClose={onClose} onRestored={vi.fn()} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
