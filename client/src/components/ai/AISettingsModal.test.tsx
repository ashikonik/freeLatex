import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AISettingsModal } from './AISettingsModal.js';
import { readAiSettings, storeAiSettings } from './ai-settings.js';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('the assistant settings', () => {
  it('shows the key that was already stored', () => {
    storeAiSettings({ provider: 'anthropic', apiKey: 'sk-stored' });

    render(<AISettingsModal onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByTestId('ai-api-key')).toHaveValue('sk-stored');
    expect(screen.getByTestId('ai-provider')).toHaveValue('anthropic');
  });

  it('keeps the key and the provider it was given', () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(<AISettingsModal onClose={onClose} onSaved={onSaved} />);

    fireEvent.change(screen.getByTestId('ai-provider'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByTestId('ai-api-key'), { target: { value: '  sk-new  ' } });
    fireEvent.click(screen.getByTestId('save-ai-settings'));

    expect(onSaved).toHaveBeenCalledWith({ provider: 'openai', apiKey: 'sk-new' });
    expect(readAiSettings()).toEqual({ provider: 'openai', apiKey: 'sk-new' });
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses to save a key that is not there', () => {
    const onSaved = vi.fn();

    render(<AISettingsModal onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByTestId('save-ai-settings'));

    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('key is needed');
  });

  it('forgets the key and says so', () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-stored' });
    const onForgotten = vi.fn();

    render(
      <AISettingsModal onClose={vi.fn()} onSaved={vi.fn()} onForgotten={onForgotten} />,
    );

    fireEvent.click(screen.getByTestId('forget-ai-key'));

    expect(readAiSettings()).toBeUndefined();
    expect(screen.getByTestId('ai-api-key')).toHaveValue('');
    expect(onForgotten).toHaveBeenCalled();
  });

  it('closes when the reader presses Escape', () => {
    const onClose = vi.fn();

    render(<AISettingsModal onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
