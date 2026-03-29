import { transformGeminiEvent } from '@/core/sdk/transformSDKMessage';

describe('transformSDKMessage compatibility', () => {
  it('supports current flat assistant message events', () => {
    const results = [...transformGeminiEvent({
      type: 'message',
      role: 'assistant',
      content: 'Hello from flat event',
    })];

    expect(results).toEqual([
      { type: 'text', content: 'Hello from flat event', parentToolUseId: null },
    ]);
  });

  it('supports legacy assistant.message.content[] blocks', () => {
    const results = [...transformGeminiEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Thinking...' },
          { type: 'text', text: 'Hello from content blocks' },
        ],
      },
    } as any)];

    expect(results).toEqual([
      { type: 'thinking', content: 'Thinking...', parentToolUseId: null },
      { type: 'text', content: 'Hello from content blocks', parentToolUseId: null },
    ]);
  });

  it('supports legacy stream_event text deltas', () => {
    const results = [...transformGeminiEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'text_delta',
          text: ' delta text',
        },
      },
    } as any)];

    expect(results).toEqual([
      { type: 'text', content: ' delta text', parentToolUseId: null },
    ]);
  });
});
