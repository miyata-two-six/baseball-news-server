import { GeminiService } from '../src/gemini/gemini.service';
import { OpenaiService } from '../src/openai/openai.service';
import { ClaudeService } from '../src/claude/claude.service';
import { NewsCategory } from '../src/enums/news/news-category.enum';

type GeminiPrivate = {
  geminiGenerateText(prompt: string): Promise<string>;
  parseJsonFromModel<T>(raw: string): T;
};

type OpenAIPrivate = {
  openaiGenerateNewsJson(prompt: string): Promise<unknown[]>;
};

type ClaudePrivate = {
  claudeGenerateJson(prompt: string): Promise<string>;
  parseJsonFromModel<T>(raw: string): T;
};

type GeminiRequestBody = {
  contents: {
    parts: {
      text: string;
    }[];
  }[];
};

function isGeminiRequestBody(value: unknown): value is GeminiRequestBody {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const body = value as {
    contents?: {
      parts?: {
        text?: unknown;
      }[];
    }[];
  };

  return Array.isArray(body.contents)
    && Array.isArray(body.contents[0]?.parts)
    && typeof body.contents[0]?.parts[0]?.text === 'string';
}

const sampleNews = {
  reference_url: 'https://example.com/news/1',
  reference_name: 'Example Source',
  reference_published_at: '2026-05-25T00:00:00.000Z',
  header: 'サンプル見出し',
  subheader: 'サンプルサブヘッダー',
  summary: 'サンプル要約',
  body: 'サンプル本文です。',
  category: NewsCategory.NPB,
};

describe('External API contracts', () => {
  const originalEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };

  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANTHROPIC_API_KEY = 'test-claude-key';
  });

  afterAll(() => {
    process.env.GEMINI_API_KEY = originalEnv.GEMINI_API_KEY;
    process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
  });

  describe('GeminiService contract', () => {
    let service: GeminiService;
    let fetchSpy: jest.SpiedFunction<typeof fetch>;

    beforeEach(() => {
      service = new GeminiService();
      fetchSpy = jest.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('extracts text from Gemini candidates.parts response', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'first ' }, { text: 'second' }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const result = await (service as unknown as GeminiPrivate).geminiGenerateText('prompt');

      expect(result).toBe('first second');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('parses JSON array from Gemini raw output', () => {
      const raw = '```json\n[\n  {"reference_url":"https://example.com/news/1"}\n]\n```';

      const result = (service as unknown as GeminiPrivate).parseJsonFromModel<Array<{ reference_url: string }>>(raw);

      expect(result).toEqual([{ reference_url: 'https://example.com/news/1' }]);
    });

    it('throws when candidates array is empty (after retries)', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ candidates: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
      );

      await expect((service as unknown as GeminiPrivate).geminiGenerateText('prompt')).rejects.toThrow('Gemini returned empty text');
    }, 20000);

    it('throws when fetch rejects (network error)', async () => {
      fetchSpy.mockRejectedValue(new Error('network error'));

      await expect((service as unknown as GeminiPrivate).geminiGenerateText('prompt')).rejects.toThrow('network error');
    }, 20000);

    it('throws when parseJsonFromModel receives invalid JSON', () => {
      const raw = '```json\n{ invalid json }\n```';

      expect(() => (service as unknown as GeminiPrivate).parseJsonFromModel(raw)).toThrow();
    });

    it('sends API key in URL and includes prompt in request body', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: 'ok' }] } },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );

      const prompt = 'my-prompt';
      const result = await (service as unknown as GeminiPrivate).geminiGenerateText(prompt);

      // verify result and that fetch was called
      expect(result).toBe('ok');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      expect(typeof calledUrl).toBe('string');
      if (typeof calledUrl !== 'string') {
        throw new Error('Expected Gemini request URL to be a string');
      }
      expect(calledUrl).toContain('?key=test-gemini-key');

      const bodyText = typeof calledInit?.body === 'string' ? calledInit.body : '';
      const parsedBody: unknown = JSON.parse(bodyText);
      expect(isGeminiRequestBody(parsedBody)).toBe(true);
      if (!isGeminiRequestBody(parsedBody)) {
        throw new Error('Invalid Gemini request body');
      }

      expect(parsedBody.contents[0].parts[0].text).toBe(prompt);

      const headers = (calledInit && (calledInit.headers ?? {})) as Record<string, string>;
      expect(headers['Content-Type'] || headers['content-type']).toBe('application/json');
    });

    it('uses the first candidate when multiple candidates returned', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: 'first-candidate' }] } },
              { content: { parts: [{ text: 'second-candidate' }] } },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const result = await (service as unknown as GeminiPrivate).geminiGenerateText('prompt');
      expect(result).toBe('first-candidate');
    });

    it('preserves internal whitespace and newlines in parts when joining', async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: 'line1\n' }, { text: '  line2 ' }] } },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const result = await (service as unknown as GeminiPrivate).geminiGenerateText('prompt');
      expect(result).toBe('line1\n  line2 ');
    });
  });

  describe('OpenaiService contract', () => {
    let service: OpenaiService;
    let createMock: jest.Mock;

    beforeEach(() => {
      service = new OpenaiService();
      createMock = jest.fn();

      Object.defineProperty(service, 'openai', {
        value: {
          responses: {
            create: createMock,
          },
        },
      });
    });

    it('accepts structured output wrapper with items array', async () => {
      createMock.mockResolvedValue({
        output_text: JSON.stringify({ items: [sampleNews] }),
      });

      const result = await (service as unknown as OpenAIPrivate).openaiGenerateNewsJson('prompt');

      expect(result).toEqual([sampleNews]);
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('throws when OpenAI returns empty output_text', async () => {
      createMock.mockResolvedValue({ output_text: '' });

      await expect((service as unknown as OpenAIPrivate).openaiGenerateNewsJson('prompt')).rejects.toThrow('OpenAI returned empty text');
    }, 20000);

    it('throws when OpenAI output_text is invalid JSON', async () => {
      createMock.mockResolvedValue({ output_text: 'not json' });

      await expect((service as unknown as OpenAIPrivate).openaiGenerateNewsJson('prompt')).rejects.toThrow();
    }, 20000);

    it('calls responses.create with prompt and structured format', async () => {
      createMock.mockResolvedValue({ output_text: JSON.stringify({ items: [sampleNews] }) });

      const prompt = 'openai-prompt';
      const result = await (service as unknown as OpenAIPrivate).openaiGenerateNewsJson(prompt);

      expect(result).toEqual([sampleNews]);
      expect(createMock).toHaveBeenCalledTimes(1);

      const calls: unknown = createMock.mock.calls;
      if (!Array.isArray(calls) || calls.length === 0) throw new Error('OpenAI create not called');
      const firstCall: unknown = (calls as unknown[])[0];
      if (!Array.isArray(firstCall) || firstCall.length === 0) throw new Error('OpenAI create called without args');
      const callArg = firstCall[0] as Record<string, unknown>;
      expect(callArg.input).toBe(prompt);
      expect(typeof callArg.text === 'object' || callArg.text !== undefined).toBe(true);
    });
  });

  describe('ClaudeService contract', () => {
    let service: ClaudeService;
    let createMock: jest.Mock;

    beforeEach(() => {
      service = new ClaudeService();
      createMock = jest.fn();

      Object.defineProperty(service, 'anthropic', {
        value: () => ({
          messages: {
            create: createMock,
          },
        }),
      });
    });

    it('extracts text blocks from Claude messages response', async () => {
      createMock.mockResolvedValue({
        content: [
          { type: 'text', text: '[]' },
          { type: 'text', text: '' },
        ],
      });

      const result = await (service as unknown as ClaudePrivate).claudeGenerateJson('prompt');

      expect(result).toBe('[]');
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    it('parses JSON array from Claude raw text', () => {
      const raw = 'prefix [ {"reference_url":"https://example.com/news/1"} ] suffix';

      const result = (service as unknown as ClaudePrivate).parseJsonFromModel<Array<{ reference_url: string }>>(raw);

      expect(result).toEqual([{ reference_url: 'https://example.com/news/1' }]);
    });

    it('throws when Claude messages.create returns empty content', async () => {
      createMock.mockResolvedValue({ content: [] });

      await expect((service as unknown as ClaudePrivate).claudeGenerateJson('prompt')).rejects.toThrow('Claude returned empty text');
    });

    it('calls messages.create with correct prompt in messages', async () => {
      createMock.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });

      const prompt = 'claude-prompt';
      const result = await (service as unknown as ClaudePrivate).claudeGenerateJson(prompt);
      expect(result).toBe('[]');
      expect(createMock).toHaveBeenCalledTimes(1);

      const callsC: unknown = createMock.mock.calls;
      if (!Array.isArray(callsC) || callsC.length === 0) throw new Error('Claude create not called');
      const firstCallC: unknown = (callsC as unknown[])[0];
      if (!Array.isArray(firstCallC) || firstCallC.length === 0) throw new Error('Claude create called without args');
      const callArg = firstCallC[0] as { messages?: { role?: string; content?: string }[] };
      expect(Array.isArray(callArg.messages)).toBe(true);
      expect(callArg.messages?.[0]?.content).toBe(prompt);
    });
  });
});