import { Injectable, NgZone, computed, inject, signal } from '@angular/core';

export type Status = 'up' | 'degraded' | 'down' | 'pending';

export interface Check { name: string; level: 'ok' | 'warn' | 'fail'; detail: string; }
export interface HistoryPoint { t: string; ms: number | null; status: Status; }
export interface SiteResult {
  name: string;
  domain: string;
  status: Status;
  httpStatus?: number | null;
  responseMs?: number | null;
  timings?: { dns?: number; connect?: number; tls?: number; ttfb?: number; total?: number } | null;
  finalUrl?: string;
  redirectChain?: { url: string; status: number | null; ms: number }[];
  cert?: { subject?: string; issuer?: string; validTo: string; daysLeft: number; authorized: boolean } | null;
  server?: string | null;
  pageBytes?: number | null;
  ips?: string[];
  checks?: Check[];
  checkedAt?: string;
  history: HistoryPoint[];
}

/** Talks to the Node checker over Server-Sent Events; falls back to polling. */
@Injectable({ providedIn: 'root' })
export class HealthService {
  private zone = inject(NgZone);
  private es?: EventSource;

  readonly sites = signal<SiteResult[]>([]);
  readonly connected = signal(false);
  readonly checking = signal(false);
  readonly lastRun = signal<Date | null>(null);
  readonly nextRun = signal<Date | null>(null);
  readonly intervalSeconds = signal(60);

  readonly counts = computed(() => {
    const c = { up: 0, degraded: 0, down: 0, pending: 0 };
    for (const s of this.sites()) c[s.status]++;
    return c;
  });

  /** Fired when a site changes between up / degraded / down. */
  onStatusChange?: (site: SiteResult, from: Status) => void;

  connect() {
    this.es?.close();
    const es = (this.es = new EventSource('/api/stream'));
    const run = (fn: () => void) => this.zone.run(fn);

    es.onopen = () => run(() => this.connected.set(true));
    es.onerror = () => run(() => this.connected.set(false)); // EventSource retries automatically

    es.addEventListener('snapshot', (e) => run(() => {
      const d = JSON.parse((e as MessageEvent).data);
      this.intervalSeconds.set(d.intervalSeconds);
      this.sites.set(d.sites);
      const latest = d.sites.map((s: SiteResult) => s.checkedAt).filter(Boolean).sort().pop();
      if (latest) {
        this.lastRun.set(new Date(latest));
        this.nextRun.set(new Date(new Date(latest).getTime() + d.intervalSeconds * 1000));
      }
    }));
    es.addEventListener('checking', () => run(() => this.checking.set(true)));
    es.addEventListener('site', (e) => run(() => {
      const site: SiteResult = JSON.parse((e as MessageEvent).data);
      this.sites.update((list) => list.map((s) => {
        if (s.domain !== site.domain) return s;
        if (s.status !== 'pending' && s.status !== site.status) this.onStatusChange?.(site, s.status);
        return site;
      }));
    }));
    es.addEventListener('done', (e) => run(() => {
      const d = JSON.parse((e as MessageEvent).data);
      this.checking.set(false);
      this.lastRun.set(new Date(d.at));
      this.nextRun.set(new Date(Date.now() + d.nextInSeconds * 1000));
    }));
  }

  async checkNow() {
    this.checking.set(true);
    await fetch('/api/check', { method: 'POST' }).catch(() => this.checking.set(false));
  }
}
