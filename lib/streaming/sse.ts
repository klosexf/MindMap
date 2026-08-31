/**
 * SSE 流解析（从 generate-form.tsx 抽出，供生成会话与表单调试模式复用）。
 * 纯解析逻辑，不依赖 DOM/React，可在 node 环境单测。
 */

export interface StreamEvent {
  type: string;
  data: any;
}

export async function* consumeSSEStream(response: Response): AsyncGenerator<StreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const messages = buffer.split('\n\n');
    buffer = messages.pop() || '';

    for (const message of messages) {
      const lines = message.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      const type = eventLine.replace('event: ', '').trim();
      const raw = dataLine.replace('data: ', '').trim();
      try {
        yield { type, data: JSON.parse(raw) };
      } catch {
        // 坏 JSON 帧跳过，不中断流
      }
    }
  }
}
