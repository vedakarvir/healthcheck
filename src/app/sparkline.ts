import { Component, computed, input } from '@angular/core';
import { HistoryPoint } from './health.service';

/** Response-time trend; failed checks drop to the baseline as red ticks. */
@Component({
  selector: 'app-sparkline',
  template: `
    <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" role="img"
         [attr.aria-label]="'Response time over last ' + points().length + ' checks'">
      <line x1="0" [attr.y1]="H - 1" [attr.x2]="W" [attr.y2]="H - 1" class="base" />
      @if (path()) { <path [attr.d]="area()" class="area" /> <path [attr.d]="path()" class="line" /> }
      @for (p of fails(); track $index) { <rect [attr.x]="p.x - 1.5" [attr.y]="0" width="3" [attr.height]="H" class="fail" /> }
      @if (last(); as l) { <circle [attr.cx]="l.x" [attr.cy]="l.y" r="3" class="dot" /> }
    </svg>
  `,
  styles: [`
    :host { display: block; height: 48px; }
    svg { width: 100%; height: 100%; overflow: visible; }
    .base { stroke: var(--line); stroke-width: 1; }
    .line { fill: none; stroke: var(--accent); stroke-width: 1.75; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
    .area { fill: var(--accent); opacity: .12; }
    .fail { fill: var(--down); opacity: .55; }
    .dot { fill: var(--accent); stroke: var(--card); stroke-width: 2; vector-effect: non-scaling-stroke; }
  `],
})
export class Sparkline {
  readonly history = input<HistoryPoint[]>([]);
  readonly W = 300;
  readonly H = 48;

  readonly points = computed(() => {
    const h = this.history().slice(-60);
    const vals = h.map((p) => p.ms ?? 0);
    const max = Math.max(500, ...vals) * 1.15;
    const step = h.length > 1 ? this.W / (h.length - 1) : 0;
    return h.map((p, i) => ({
      x: h.length > 1 ? i * step : this.W,
      y: p.ms == null ? this.H - 1 : this.H - 2 - ((p.ms / max) * (this.H - 6)),
      ok: p.ms != null && p.status !== 'down',
    }));
  });
  readonly path = computed(() => {
    const ok = this.points().filter((p) => p.ok);
    return ok.length ? ok.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') : '';
  });
  readonly area = computed(() => {
    const ok = this.points().filter((p) => p.ok);
    return ok.length ? `${this.path()} L${ok[ok.length - 1].x},${this.H} L${ok[0].x},${this.H} Z` : '';
  });
  readonly fails = computed(() => this.points().filter((p) => !p.ok));
  readonly last = computed(() => this.points().filter((p) => p.ok).pop());
}
