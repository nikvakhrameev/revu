// SSE subscription to a managed difit instance's /api/watch channel.
// The daemon snapshots comment threads on every commentsChanged event and
// reacts to the Finish review signal.

export interface WatchHandlers {
  onCommentsChanged: () => void;
  onReviewFinished: () => void;
  onDisconnect: () => void;
}

export class InstanceWatcher {
  private abort = new AbortController();
  private stopped = false;

  constructor(
    private readonly port: number,
    private readonly handlers: WatchHandlers,
  ) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(`http://localhost:${this.port}/api/watch`, {
          signal: this.abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`watch endpoint returned ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.handleFrame(frame);
          }
        }
      } catch {
        // fall through to reconnect/disconnect handling
      }
      if (this.stopped) return;
      // Connection dropped: check if the instance is still there before retrying.
      await new Promise((r) => setTimeout(r, 500));
      try {
        const probe = await fetch(`http://localhost:${this.port}/api/instance-info`, {
          signal: AbortSignal.timeout(1000),
        });
        if (!probe.ok) throw new Error('gone');
      } catch {
        if (!this.stopped) this.handlers.onDisconnect();
        return;
      }
    }
  }

  private handleFrame(frame: string): void {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let event: unknown;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      const type = (event as { type?: string }).type;
      if (type === 'commentsChanged') this.handlers.onCommentsChanged();
      else if (type === 'reviewFinished') this.handlers.onReviewFinished();
    }
  }
}
