import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';
import { settle } from '../../../testing/fixtures';
import { SnapshotDialog } from './snapshot-dialog';

describe('snapshot confirmation', () => {
  it('freezes scope and archive options while a delayed download is pending', async () => {
    await TestBed.configureTestingModule({
      imports: [SnapshotDialog],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: { source: 'me', filters: { source: 'PROJECTS', includeCreated: true } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SnapshotDialog);
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne((request) => request.url.endsWith('/snapshots/preview'))
      .flush({
        scope: 'My work',
        mode: 'Current filtered view',
        filters: '{}',
        count: 3,
        details: 'All readable details',
      });
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    const download = Array.from(root.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Download'),
    );
    download?.click();
    await settle(fixture);
    expect(root.querySelector('mat-select')?.getAttribute('aria-disabled')).toBe('true');
    expect(root.querySelector<HTMLInputElement>('mat-checkbox input')?.disabled).toBe(true);
    const request = http.expectOne((req) => req.url === 'api/v1/me/snapshots');
    expect(request.request.params.get('offline')).toBe('false');
    expect(request.request.params.get('source')).toBe('PROJECTS');
    request.flush(new Blob(), { status: 500, statusText: 'generation failed' });
    await settle(fixture);
    expect(root.querySelector('mat-select')?.getAttribute('aria-disabled')).toBe('false');
    expect(root.querySelector('[role="status"]')).toBeNull();
    http.verify();
  });
});
