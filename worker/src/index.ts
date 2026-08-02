/**
 * Worker entrypoint: HTTP and Cron.
 *
 * Replaces `uvicorn` plus the in-process scheduler thread. There is no server
 * to keep running and no socket to bind: Cloudflare invokes `fetch` per request
 * and `scheduled` per Cron trigger.
 */

import { loadConfig, type Env } from "./env.js";
import { Repo } from "./db/repo.js";
import { runScheduledTick } from "./scheduled.js";
import { handleRequest, servicesFor } from "./web/router.js";
import { htmlResponse, layout } from "./web/html.js";
import { errorPage } from "./web/views.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      // Structured, Cloudflare-compatible logging. The response stays generic:
      // an internal failure must not become an information-disclosure channel.
      console.error(
        JSON.stringify({
          event: "unhandled_request_error",
          path: new URL(request.url).pathname,
          method: request.method,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
      const { config } = loadConfig(env);
      return htmlResponse(
        layout(
          {
            title: "Something went wrong",
            nav: "none",
            appTimezone: config.appTimezone,
            authenticated: false,
          },
          errorPage({
            status: 500,
            detail:
              "The request failed unexpectedly. Stored data is unchanged. " +
              "Check the Worker logs with `npx wrangler tail` for details.",
          }),
        ),
        { status: 500 },
      );
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { config, usable } = loadConfig(env);

    if (!usable) {
      // Refuse to run rather than half-run: without a validated configuration
      // a real failure is indistinguishable from a missing binding.
      console.error(
        JSON.stringify({
          event: "scheduled_skipped",
          reason: "configuration_incomplete",
          cron: controller.cron,
        }),
      );
      return;
    }

    const repo = new Repo(env.DB);
    // Services are built here rather than inside the tick, so the tick stays
    // testable with a fake runner.
    const { search } = servicesFor({
      request: new Request("https://scheduled.invalid/"),
      env,
      repo,
      config,
      csrf: "",
    });

    const work = runScheduledTick(repo, config, search, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    }).then((report) => {
      console.log(
        JSON.stringify({
          event: "scheduled_tick",
          cron: controller.cron,
          outcome: report.outcome,
          trackers_selected: report.trackersSelected,
          trackers_completed: report.trackersCompleted,
          queries_executed: report.queriesExecuted,
          provider_failures: report.providerFailures,
          telegram_failures: report.telegramFailures,
          alerts_sent: report.alertsSent,
          work_remaining: report.workRemaining,
        }),
      );
    });

    // Keeps the invocation alive until the tick finishes writing its record, so
    // a run is never left as "running" in cron_runs.
    ctx.waitUntil(work);
    await work;
  },
} satisfies ExportedHandler<Env>;
