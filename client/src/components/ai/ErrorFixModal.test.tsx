import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ErrorFixModal } from './ErrorFixModal.js';
import { storeAiSettings } from './ai-settings.js';

const askAi = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api.js', () => ({ askAi }));

const ERRORS = ['main.tex:12: Undefined control sequence.'];
const SOURCE = '\\section{One}\n\\undefinedcommand';

beforeEach(() => {
  window.localStorage.clear();
  askAi.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('the one-click error fix', () => {
  it('shows the errors the compiler reported', () => {
    render(
      <ErrorFixModal errors={ERRORS} source={SOURCE} onApply={vi.fn()} onClose={vi.fn()} />,
    );

    expect(screen.getByTestId('error-fix-modal')).toHaveTextContent('1 error');
    expect(screen.getByTestId('error-fix-modal')).toHaveTextContent(
      'Undefined control sequence',
    );
  });

  it('asks for a key before it asks the provider', () => {
    render(
      <ErrorFixModal errors={ERRORS} source={SOURCE} onApply={vi.fn()} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('ask-for-fix'));

    expect(screen.getByRole('alert')).toHaveTextContent('Add your provider key');
    expect(askAi).not.toHaveBeenCalled();
  });

  it('sends the errors and the document to the provider', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockResolvedValue('\\section{One}\n\\text');

    render(
      <ErrorFixModal errors={ERRORS} source={SOURCE} onApply={vi.fn()} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('ask-for-fix'));

    await waitFor(() => expect(askAi).toHaveBeenCalledTimes(1));
    const [provider, key, body] = askAi.mock.calls[0] as [
      string,
      string,
      { prompt: string; source: string; errors: string[] },
    ];
    expect(provider).toBe('openai');
    expect(key).toBe('sk-test');
    expect(body.source).toBe(SOURCE);
    expect(body.errors).toEqual(ERRORS);
  });

  it('shows the corrected document before it is applied', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockResolvedValue('\\section{One}\n\\text');
    const onApply = vi.fn();

    render(
      <ErrorFixModal errors={ERRORS} source={SOURCE} onApply={onApply} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('ask-for-fix'));

    await waitFor(() => expect(screen.getByTestId('fix-answer')).toBeInTheDocument());
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies the fix when the reader says so', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockResolvedValue('\\section{One}\n\\text');
    const onApply = vi.fn();

    render(
      <ErrorFixModal errors={ERRORS} source={SOURCE} onApply={onApply} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('ask-for-fix'));
    await waitFor(() => expect(screen.getByTestId('apply-fix')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('apply-fix'));

    expect(onApply).toHaveBeenCalledWith('\\section{One}\n\\text');
  });

  it('reports a provider that could not be reached', async () => {
    storeAiSettings({ provider: 'openai', apiKey: 'sk-test' });
    askAi.mockRejectedValue(new Error('The assistant could not be reached.'));

    render(
      <ErrorFixModal errors={ERRORS} source={SOURCE} onApply={vi.fn()} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId('ask-for-fix'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not be reached'));
  });
});
