import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-failures-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService Failure Notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-03T17:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies after 3 consecutive failures and throttles subsequent notifications", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: "Service Unreachable",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const job = await cron.add({
      name: "faulty job",
      enabled: true,
      schedule: { kind: "every", everyMs: 24 * 60 * 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping", deliver: false },
    });

    // Run 1
    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
      expect.stringContaining("Alert:"),
      expect.anything(),
    );

    // Run 2
    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(2);
    expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
      expect.stringContaining("Alert:"),
      expect.anything(),
    );

    // Run 3 - Threshold reached
    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(3);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        'Alert: Cron job "faulty job" failed 3 times in a row. Last error: Service Unreachable',
      ),
      expect.anything(),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();
    const firstAlertAt = Date.now();
    expect(job.state.lastFailureNotificationAtMs).toBe(firstAlertAt);

    // Run 4 - Throttled (1 hour)
    enqueueSystemEvent.mockClear();
    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(4);
    expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
      expect.stringContaining("Alert:"),
      expect.anything(),
    );

    // Advance 30 mins - Still throttled
    vi.advanceTimersByTime(30 * 60_000);
    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(5);
    expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
      expect.stringContaining("Alert:"),
      expect.anything(),
    );

    // Advance another 31 mins - Throttle expired
    vi.advanceTimersByTime(31 * 60_000);
    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(6);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        'Alert: Cron job "faulty job" failed 6 times in a row. Last error: Service Unreachable',
      ),
      expect.anything(),
    );

    cron.stop();
    await store.cleanup();
  });

  it("resets consecutive failures on success", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    let shouldFail = true;
    const runIsolatedAgentJob = vi.fn(async () => {
      if (shouldFail) return { status: "error" as const, error: "fail" };
      return { status: "ok" as const, summary: "ok" };
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const job = await cron.add({
      name: "recovery job",
      enabled: true,
      schedule: { kind: "every", everyMs: 24 * 60 * 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping", deliver: false },
    });

    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(1);

    shouldFail = false;
    await cron.run(job.id, "force");
    expect(job.state.consecutiveFailures).toBe(0);
    expect(job.state.lastFailureNotificationAtMs).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });
});
