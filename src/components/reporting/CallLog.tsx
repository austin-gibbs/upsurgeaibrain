"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  SectionHeader,
  Select,
} from "@/components/ui";
import { formatDuration } from "@/lib/reporting/aggregate";
import type { ReportingResponse } from "./types";

function formatCallDate(ms: number | null, iso: string | null): string {
  if (ms) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  }
  if (iso) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  }
  return "—";
}

const PAGE_SIZE = 25;

export function CallLog({
  calls,
  agents,
  crmProvider,
}: {
  calls: ReportingResponse["calls"];
  agents: ReportingResponse["agents"];
  crmProvider: string;
}) {
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.filter((c) => {
      if (agentFilter !== "all" && c.agentId !== agentFilter) return false;
      if (directionFilter !== "all" && c.direction !== directionFilter) return false;
      if (!q) return true;
      return (
        (c.contactName ?? "").toLowerCase().includes(q) ||
        (c.contactEmail ?? "").toLowerCase().includes(q) ||
        (c.phone ?? "").toLowerCase().includes(q) ||
        (c.summary ?? "").toLowerCase().includes(q)
      );
    });
  }, [calls, query, agentFilter, directionFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="mb-10">
      <SectionHeader
        title="Call log"
        description="All inbound and outbound calls with recordings and CRM links."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={agentFilter}
              onChange={(e) => {
                setAgentFilter(e.target.value);
                setPage(0);
              }}
              className="w-44"
            >
              <option value="all">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <Select
              value={directionFilter}
              onChange={(e) => {
                setDirectionFilter(e.target.value);
                setPage(0);
              }}
              className="w-36"
            >
              <option value="all">All directions</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="Search name, phone, email…"
                className="w-56 pl-9"
              />
            </div>
          </div>
        }
      />

      <Card className="overflow-hidden p-0">
        {filtered.length === 0 ? (
          <div className="p-8">
            <EmptyState
              title="No calls in this range"
              description="Adjust filters or date range to see call history."
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead>
                  <tr className="border-b border-ink-100 bg-ink-50/50 text-left text-xs font-medium uppercase tracking-wide text-ink-400">
                    <th className="px-5 py-3">Contact</th>
                    <th className="px-5 py-3">Phone</th>
                    <th className="px-5 py-3">Email</th>
                    <th className="px-5 py-3">Agent</th>
                    <th className="px-5 py-3">Direction</th>
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Duration</th>
                    <th className="px-5 py-3">Recording</th>
                    <th className="px-5 py-3">CRM</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {pageRows.map((c) => (
                    <tr key={c.retellCallId} className="transition-colors hover:bg-ink-50/50">
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-ink-900">
                          {c.contactName ?? "Unknown"}
                        </div>
                        {c.outcome && (
                          <div className="mt-0.5 text-xs capitalize text-ink-400">
                            {c.outcome.replace(/_/g, " ")}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-ink-600">
                        {c.phone ?? "—"}
                      </td>
                      <td className="px-5 py-3.5 text-ink-600">
                        {c.contactEmail ?? "—"}
                      </td>
                      <td className="px-5 py-3.5 text-ink-600">
                        {c.agentName ?? "—"}
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge tone={c.direction === "inbound" ? "green" : "blue"}>
                          {c.direction}
                        </Badge>
                      </td>
                      <td className="px-5 py-3.5 text-ink-600">
                        {formatCallDate(c.startTimestamp, c.completedAt)}
                      </td>
                      <td className="px-5 py-3.5 text-ink-600">
                        {formatDuration(c.durationSeconds)}
                      </td>
                      <td className="px-5 py-3.5">
                        {c.recordingUrl ? (
                          <audio
                            controls
                            preload="none"
                            className="h-8 max-w-[180px]"
                            src={c.recordingUrl}
                          >
                            Your browser does not support audio playback.
                          </audio>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {c.crmUrl && crmProvider === "followupboss" ? (
                          <a href={c.crmUrl} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="sm" className="gap-1">
                              View
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Button>
                          </a>
                        ) : (
                          <span className="text-xs text-ink-400">
                            {!c.crmContactId ? "No contact ID" : "Set CRM URL"}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between border-t border-ink-100 px-5 py-3 text-sm text-ink-500">
                <span>
                  Showing {page * PAGE_SIZE + 1}–
                  {Math.min((page + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page >= pageCount - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
