import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AIAssistant } from './AIAssistant.js';
import { storeAiSettings } from './ai-settings.js';

const askAi = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api.js', () => ({ askAi }));

beforeEach(() => {
  window.localStorage.clear();
  askAi.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('the writing assistant', () => {
  it('asks for a key before it asks anything', () => {
    render(<AIAssistant source="A line of the document." onApply={vi.fn()} />);

    fireEvent.click(screen.getByTestId('ai-ask'));

    expect(screen.getByTestId('ai-settings-modal')).toBeInTheDocument();
    expect(askAi).not.toHaveBeenCalled();
  });

  it('sends the task and the source to the provider', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockResolvedValue('The polished text.');
    const source = 'A line of the document.';

    render(<AIAssistant source={source} onApply={vi.fn()} />);

    fireEvent.click(screen.getByTestId('ai-ask'));

    await waitFor(() => expect(askAi).toHaveBeenCalledTimes(1));
    const [provider, key, body] = askAi.mock.calls[0] as [
      string,
      string,
      { prompt: string; source: string },
    ];
    expect(provider).toBe('openai');
    expect(key).toBe('sk-test');
    expect(body.source).toBe(source);
  });

  it('shows the answer the provider gave', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockResolvedValue('The polished text.');

    render(<AIAssistant source="" onApply={vi.fn()} />);

    fireEvent.click(screen.getByTestId('ai-ask'));

    await waitFor(() => expect(screen.getByTestId('ai-answer')).toBeInTheDocument());
    expect(screen.getByTestId('ai-answer')).toHaveTextContent('The polished text.');
  });

  it('hands the answer to the reader rather than editing on its own', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockResolvedValue('The polished text.');
    const onApply = vi.fn();

    render(<AIAssistant source="" onApply={onApply} />);

    fireEvent.click(screen.getByTestId('ai-ask'));

    await waitFor(() => expect(screen.getByTestId('ai-apply')).toBeInTheDocument());
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('ai-apply'));

    expect(onApply).toHaveBeenCalledWith('The polished text.');
  });

  it('reports a provider that could not be reached', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockRejectedValue(new Error('The assistant could not be reached.'));

    render(<AIAssistant source="" onApply={vi.fn()} />);

    fireEvent.click(screen.getByTestId('ai-ask'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be reached'));
  });

  it('offers every task it knows', () => {
    render(<AIAssistant source="" onApply={vi.fn()} />);

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(4);
  });

  it('stops sending a key that has been forgotten', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockResolvedValue('The polished text.');

    render(<AIAssistant source="" onApply={vi.fn()} />);

    fireEvent.click(screen.getByTestId('ai-settings-button'));
    fireEvent.click(screen.getByTestId('forget-ai-key'));

    fireEvent.click(screen.getByTestId('ai-ask'));

    // With the key gone, the assistant asks for a key again rather than
    // sending the one that was forgotten.
    expect(screen.getByTestId('ai-settings-modal')).toBeInTheDocument();
    expect(askAi).not.toHaveBeenCalled();
  });
});
