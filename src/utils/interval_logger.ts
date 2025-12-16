export class IntervalLogger {
  private lastLog: number = 0;

  constructor(private intervalMs: number) {}

  log(message: string) {
    const now = Date.now();
    if (now - this.lastLog >= this.intervalMs) {
      console.log(`[Interval Log]: ${message}`);
      this.lastLog = now;
    }
  }
};