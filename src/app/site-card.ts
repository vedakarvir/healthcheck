import { Component, computed, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { SiteResult } from './health.service';
import { Sparkline } from './sparkline';

@Component({
  selector: 'app-site-card',
  imports: [Sparkline, DatePipe, DecimalPipe],
  template: `
    @let s = site();
    <article class="card" [class]="'card s-' + s.status">
      <header>
        <div class="title">
          <span class="pill">{{ label() }}</span>
          <h2>{{ s.name }}</h2>
          <a [href]="'https://' + s.domain" target="_blank" rel="noopener">{{ s.domain }} ↗</a>
        </div>
        <div class="metric">
          @if (s.responseMs != null) {
            <strong>{{ s.responseMs | number }}</strong><span>ms</span>
          } @else { <strong>—</strong> }
        </div>
      </header>

      <app-sparkline [history]="s.history" />

      <dl class="stats">
        <div><dt>HTTP</dt><dd>{{ s.httpStatus ?? '—' }}</dd></div>
        <div><dt>Uptime</dt><dd>{{ uptime() == null ? '—' : (uptime() | number: '1.0-1') + '%' }}</dd></div>
        <div><dt>SSL</dt><dd [class.warnTxt]="(s.cert?.daysLeft ?? 99) < 14">{{ s.cert ? s.cert.daysLeft + 'd' : '—' }}</dd></div>
        <div><dt>Avg</dt><dd>{{ avg() == null ? '—' : (avg() | number: '1.0-0') + 'ms' }}</dd></div>
      </dl>

      <ul class="checks">
        @for (c of s.checks ?? []; track c.name) {
          <li [class]="c.level">
            <span class="ic" aria-hidden="true">{{ c.level === 'ok' ? '✓' : c.level === 'warn' ? '!' : '✕' }}</span>
            <span class="cn">{{ c.name }}</span>
            <span class="cd" [title]="c.detail">{{ c.detail }}</span>
          </li>
        } @empty { <li class="waiting">Waiting for first check…</li> }
      </ul>

      @if (s.timings?.total) {
        <button class="more" (click)="open.set(!open())" [attr.aria-expanded]="open()">
          {{ open() ? 'Hide' : 'Show' }} details
        </button>
        @if (open()) {
          <div class="details">
            <div class="wf" aria-label="Request timing">
              @for (seg of waterfall(); track seg.k) {
                <div class="seg" [style.left.%]="seg.from" [style.width.%]="seg.w" [class]="'seg ' + seg.k" [title]="seg.k + ': ' + seg.ms + 'ms'"></div>
              }
            </div>
            <div class="legend">
              @for (seg of waterfall(); track seg.k) { <span><i [class]="seg.k"></i>{{ seg.k }} {{ seg.ms }}ms</span> }
            </div>
            <dl class="kv">
              @if (s.redirectChain && s.redirectChain.length > 1) {
                <dt>Redirects</dt>
                <dd>@for (r of s.redirectChain; track $index) { <div>{{ r.status }} {{ r.url }}</div> }</dd>
              }
              <dt>Final URL</dt><dd>{{ s.finalUrl }}</dd>
              @if (s.ips?.length) { <dt>IP</dt><dd>{{ s.ips!.join(', ') }}</dd> }
              @if (s.server) { <dt>Server</dt><dd>{{ s.server }}</dd> }
              @if (s.pageBytes) { <dt>Page size</dt><dd>{{ s.pageBytes / 1024 | number: '1.0-0' }} KB</dd> }
              @if (s.cert) { <dt>Certificate</dt><dd>{{ s.cert.issuer }} · expires {{ s.cert.validTo | date: 'd MMM y' }}</dd> }
            </dl>
          </div>
        }
      }
      <footer>{{ s.checkedAt ? 'Checked ' + (s.checkedAt | date: 'HH:mm:ss') : 'Pending' }}</footer>
    </article>
  `,
  styleUrl: './site-card.css',
})
export class SiteCard {
  readonly site = input.required<SiteResult>();
  readonly open = signal(false);

  readonly label = computed(() => ({ up: 'Operational', degraded: 'Degraded', down: 'Down', pending: 'Checking' })[this.site().status]);
  readonly uptime = computed(() => {
    const h = this.site().history;
    return h.length ? (h.filter((p) => p.status !== 'down').length / h.length) * 100 : null;
  });
  readonly avg = computed(() => {
    const v = this.site().history.map((p) => p.ms).filter((m): m is number => m != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  readonly waterfall = computed(() => {
    const t = this.site().timings!;
    const total = t.total || 1;
    const marks: [string, number | undefined][] = [['dns', t.dns], ['connect', t.connect], ['tls', t.tls], ['wait', t.ttfb], ['download', t.total]];
    let prev = 0;
    return marks.filter(([, v]) => v != null).map(([k, v]) => {
      const seg = { k, from: (prev / total) * 100, w: Math.max(0.8, ((v! - prev) / total) * 100), ms: Math.round(v! - prev) };
      prev = v!;
      return seg;
    });
  });
}
