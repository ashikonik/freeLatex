import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Header } from './Header.js';

/** The properties every test starts from. */
const BASE = {
  title: 'A thesis',
  activePath: 'main.tex',
  mode: 'wasm' as const,
  onModeChange: vi.fn(),
  onShare: vi.fn(),
  onHistory: vi.fn(),
  status: 'connected' as const,
  onBack: vi.fn(),
};

describe('the workspace header', () => {
  it('shows the project and the file that is open', () => {
    render(<Header {...BASE} />);

    expect(screen.getByText('A thesis')).toBeInTheDocument();
    expect(screen.getByText('main.tex')).toBeInTheDocument();
  });

  it('offers both engines', () => {
    render(<Header {...BASE} />);

    expect(screen.getByRole('option', { name: '⚡ Instant Wasm Preview' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '🖥️ Server Tectonic Build' })).toBeInTheDocument();
  });

  it('shows the mode that is in use', () => {
    render(<Header {...BASE} mode="server" />);

    expect(screen.getByTestId('build-mode')).toHaveValue('server');
  });

  it('reports a change of engine', () => {
    const onModeChange = vi.fn();
    render(<Header {...BASE} onModeChange={onModeChange} />);

    fireEvent.change(screen.getByTestId('build-mode'), { target: { value: 'server' } });

    expect(onModeChange).toHaveBeenCalledWith('server');
  });

  it('asks for a share link and for the history', () => {
    const onShare = vi.fn();
    const onHistory = vi.fn();
    render(<Header {...BASE} onShare={onShare} onHistory={onHistory} />);

    fireEvent.click(screen.getByTestId('share-button'));
    fireEvent.click(screen.getByTestId('history-button'));

    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledTimes(1);
  });

  it('shows the state of the collaboration session', () => {
    const { rerender } = render(<Header {...BASE} status="connected" />);

    expect(screen.getByTestId('connection-status')).toHaveTextContent('Connected');

    rerender(<Header {...BASE} status="offline" />);

    expect(screen.getByTestId('connection-status')).toHaveTextContent('Offline');
  });

  it('offers the assistant when there is one to offer', () => {
    const onAssistant = vi.fn();
    render(<Header {...BASE} onAssistant={onAssistant} />);

    fireEvent.click(screen.getByTestId('assistant-button'));

    expect(onAssistant).toHaveBeenCalledTimes(1);
  });

  it('leaves the assistant out when there is none', () => {
    render(<Header {...BASE} />);

    expect(screen.queryByTestId('assistant-button')).not.toBeInTheDocument();
  });

  it('offers to fix the errors the build reported', () => {
    const onFixErrors = vi.fn();
    render(<Header {...BASE} onFixErrors={onFixErrors} errorCount={3} />);

    fireEvent.click(screen.getByTestId('fix-errors-button'));

    expect(onFixErrors).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('fix-errors-button')).toHaveTextContent('Fix 3 errors');
  });

  it('leaves the error fix out when nothing is wrong', () => {
    render(<Header {...BASE} onFixErrors={vi.fn()} errorCount={0} />);

    expect(screen.queryByTestId('fix-errors-button')).not.toBeInTheDocument();
  });
});
