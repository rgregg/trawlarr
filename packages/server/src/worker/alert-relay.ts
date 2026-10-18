import type { FlowMessageStatus } from '../alerts/alert-service.js';

/** What a flow node may say about an alert: a destination's NAME and a message, nothing else. */
export interface AlertRequest {
  destination: string;
  message: string;
}

/** Where a handle puts one line of a job's log; each handle supplies its own. */
export type JobLogSink = (text: string) => void;

/**
 * At most this many alert-requests are honoured per job. A plugin stuck in a
 * loop would otherwise turn one file into an unbounded stream of webhook
 * deliveries; the cap is far above any legitimate flow.
 */
export const MAX_ALERTS_PER_JOB = 100;

/**
 * The daemon's side of `alert-request` for ONE job.
 *
 * The library, path and job id come from the job's own payload (built from its
 * job, file and library rows at claim), never from the message: the message
 * crossed a channel plugin code can write to, so a plugin must not be able to
 * attribute an alert to another file. Failures are logged to the job, naming
 * the destination and the reason but never a URL or header (the destination's
 * secrets must not reach a log a node or user can read). Nothing here throws
 * into the handle that called it.
 */
export const createJobAlertRelay = (input: {
  job: { jobId: string; path: string; libraryName: string };
  raise: (request: {
    destination: string;
    message: string;
    library: string;
    path: string;
    jobId: string;
  }) => FlowMessageStatus;
}): ((request: AlertRequest, log: JobLogSink) => void) => {
  let count = 0;
  return (request, log) => {
    try {
      count += 1;
      if (count > MAX_ALERTS_PER_JOB) {
        // One line only, at the first refusal; the rest are silent.
        if (count === MAX_ALERTS_PER_JOB + 1) log('Alert limit reached for this job');
        return;
      }
      const status = input.raise({
        destination: request.destination,
        message: request.message,
        library: input.job.libraryName,
        path: input.job.path,
        jobId: input.job.jobId,
      });
      const name = JSON.stringify(request.destination);
      if (status === 'unknown') log(`Alert not sent: destination ${name} is unknown`);
      else if (status === 'disabled') log(`Alert not sent: destination ${name} is disabled`);
      else if (status === 'error') log(`Alert not sent: destination ${name} could not be queued`);
    } catch {
      // An alert is never worth failing a job over.
    }
  };
};
