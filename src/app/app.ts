import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HealthService } from './health.service';
import { SiteCard } from './site-card';

@Component({
  selector: 'app-root',
  imports: [SiteCard, DatePipe],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly health = inject(HealthService);
  private readonly now = signal(Date.now());
  protected readonly notify = signal(typeof Notification !== 'undefined' && Notification.permission === 'granted');

  protected readonly overall = computed(() => {
    const c = this.health.counts();
    if (c.down) return { tone: 'down', text: `${c.down} site${c.down > 1 ? 's' : ''} down` };
    if (c.degraded) return { tone: 'degraded', text: `${c.degraded} site${c.degraded > 1 ? 's' : ''} degraded` };
    if (c.pending && !c.up) return { tone: 'pending', text: 'Running first checks…' };
    return { tone: 'up', text: 'All systems operational' };
  });

  protected readonly countdown = computed(() => {
    const next = this.health.nextRun();
    if (this.health.checking()) return 'checking…';
    if (!next) return '—';
    const s = Math.max(0, Math.round((next.getTime() - this.now()) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  });

  constructor() {
    this.health.connect();
    const tick = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));

    // Tab title reflects health so a background tab still tells you something is wrong.
    effect(() => {
      const c = this.health.counts();
      document.title = c.down ? `🔴 ${c.down} down · Site Health` : c.degraded ? `🟠 ${c.degraded} degraded · Site Health` : 'Site Health';
    });

    this.health.onStatusChange = (site, from) => {
      if (!this.notify()) return;
      const verb = site.status === 'up' ? 'recovered' : site.status === 'down' ? 'is DOWN' : 'is degraded';
      new Notification(`${site.domain} ${verb}`, {
        body: site.checks?.find((c) => c.level !== 'ok')?.detail ?? `Was ${from}, now ${site.status}`,
        tag: site.domain,
      });
    };
  }

  protected async toggleNotify() {
    if (this.notify()) return this.notify.set(false);
    if (typeof Notification === 'undefined') return;
    this.notify.set((await Notification.requestPermission()) === 'granted');
  }
}
