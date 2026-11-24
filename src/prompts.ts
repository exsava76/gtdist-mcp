import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const ask = (text: string): GetPromptResult => ({
  messages: [{ role: 'user', content: { type: 'text', text } }],
});

/** The main GTD flows as ready-made prompts; each names the tools to use in order. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'process_inbox',
    {
      title: 'Process the inbox',
      description: 'Clarify the GTDist inbox item by item until it is empty (GTD «clarify»).',
    },
    () =>
      ask(
        'Help me process my GTDist inbox to zero. Call list_inbox and take the items one at a time, oldest first. ' +
          'For each ask: is it actionable? Not actionable → trash or someday. Takes under two minutes → I do it now, ' +
          'then clarify_item to=done. Needs several steps → to=project with the outcome and its first next action. ' +
          'Someone else does it → to=waiting with the person. A fixed day → to=scheduled only if I named the date. ' +
          'Otherwise → to=next with a concrete, visible next action and its context (list_contexts). ' +
          'suggest_clarification can propose a wording. Always preview with dry_run=true, show me what changes, ' +
          'then apply. Never invent deadlines. Each write returns an audit_id for undo.',
      ),
  );

  server.registerPrompt(
    'weekly_review',
    {
      title: 'Weekly review',
      description: 'Walk through the GTD weekly review: get clear, get current, get creative.',
    },
    () =>
      ask(
        'Run my GTDist weekly review with me. Call start_weekly_review and go through its steps one by one, ' +
          'marking each with review_step. Get clear: empty the inbox (list_inbox, clarify_item). Get current: ' +
          'get_calendar for the past and next weeks, list_actions status=next, list_waiting older_than_days=7 ' +
          '(draft_reminder for overdue ones), find_stuck_projects — propose a next action for each, list_projects, ' +
          'get_nudges. Get creative: list_actions status=someday and get_horizons — what to activate or drop. ' +
          'Ask before every change, preview with dry_run where available, and summarise at the end.',
      ),
  );

  server.registerPrompt(
    'plan_now',
    {
      title: 'What to do now',
      description: 'Pick what fits right now by context, time available and energy.',
      argsSchema: {
        minutes: z.string().optional().describe('Time available, in minutes'),
        where: z.string().optional().describe('Where I am or what I have at hand'),
        energy: z.string().optional().describe('low, mid or high'),
      },
    },
    (a) =>
      ask(
        `Help me choose what to do now in GTDist.${a.minutes ? ` I have ${a.minutes} minutes.` : ''}` +
          `${a.where ? ` I am at / with: ${a.where}.` : ''}${a.energy ? ` Energy: ${a.energy}.` : ''} ` +
          'Find the matching contexts with list_contexts (set_current_context if my situation changed), then call ' +
          'get_next_actions with them, minutes and energy. Mind the hard landscape it returns (calendar and deadlines). ' +
          'Suggest one to three actions and say why; do not reshuffle priorities I did not ask about. ' +
          'When I finish one, complete_action.',
      ),
  );

  server.registerPrompt(
    'prepare_conversation',
    {
      title: 'Prepare a conversation',
      description: 'Everything to discuss with a person and what you wait for from them.',
      argsSchema: { person: z.string().describe('Who the conversation is with') },
    },
    (a) =>
      ask(
        `Prepare me for a conversation with ${a.person} using GTDist. Find the person with list_contexts type=person ` +
          '(create_context only if I confirm they are new). Call get_agenda for what to discuss and what I wait for from ' +
          'them, summarize_agenda for where to start, and list_comments on shared items if relevant. Give a short list: ' +
          'to discuss, to ask about (waiting-for, with since-dates), my promises to them. Offer draft_reminder for ' +
          'overdue waiting-for items — drafts only, I send them myself.',
      ),
  );
}
