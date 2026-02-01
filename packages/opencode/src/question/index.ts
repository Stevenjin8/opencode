import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Env } from "@/env"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import z from "zod"

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  const state = Instance.state(async () => {
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: Answer[]) => void
        reject: (e: any) => void
        controller?: AbortController
      }
    > = {}

    return {
      pending,
    }
  })

  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
  }): Promise<Answer[]> {
    const s = await state()
    const id = Identifier.ascending("question")
    const url = Env.get("OPENCODE_QUESTION_URL")
    const controller = url ? new AbortController() : undefined
    const info: Request = {
      id,
      sessionID: input.sessionID,
      questions: input.questions,
      tool: input.tool,
    }

    log.info("asking", { id, questions: input.questions.length })

    const promise = new Promise<Answer[]>((resolve, reject) => {
      s.pending[id] = {
        info,
        resolve,
        reject,
        controller,
      }
      Bus.publish(Event.Asked, info)
    })
    if (url) {
      void auto(url, info, controller)
    }
    return promise
  }

  async function auto(url: string, info: Request, controller?: AbortController) {
    const payload = info.questions.length === 1 ? encode(info.questions[0]) : info.questions.map(encode)
    const body = JSON.stringify(payload)
    const res = await fetch(url, {
      method: "POST",
      keepalive: false,
      headers: {
        "content-type": "application/json",
        connection: "close",
      },
      body,
      signal: controller?.signal,
    }).catch((error) => {
      if (error instanceof Error && error.name === "AbortError") return undefined
      log.warn("auto reply request failed", { id: info.id, error })
      return undefined
    })
    if (!res) return
    if (!res.ok) {
      log.warn("auto reply response not ok", { id: info.id, status: res.status })
      return
    }
    const json = await res.json().catch((error) => {
      log.warn("auto reply response invalid json", { id: info.id, error })
      return undefined
    })
    if (!json) return
    const parsed = Reply.safeParse(json)
    if (!parsed.success) {
      log.warn("auto reply response invalid payload", { id: info.id, error: parsed.error })
      return
    }
    await reply({
      requestID: info.id,
      answers: parsed.data.answers,
    })
  }

  function encode(question: Info) {
    const options = question.options.map((option) => option.label)
    return {
      type: options.length === 0 ? "Free Text" : "Multiple Choice",
      title: question.header,
      message: question.question,
      options,
    }
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<void> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }
    existing.controller?.abort()
    delete s.pending[input.requestID]

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    existing.resolve(input.answers)
  }

  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    existing.controller?.abort()
    delete s.pending[requestID]

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    existing.reject(new RejectedError())
  }

  export class RejectedError extends Error {
    constructor() {
      super("The user dismissed this question")
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
