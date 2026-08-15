export class PiperDiscoveryScheduler {
  constructor(runner, intervalMinutes) {
    this.runner = runner;
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const execute = () => this.runner.runAll().catch(() => { /* run rows retain failure detail */ });
    this.timer = setInterval(execute, this.intervalMs);
    this.timer.unref?.();
    setTimeout(execute, 0).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
