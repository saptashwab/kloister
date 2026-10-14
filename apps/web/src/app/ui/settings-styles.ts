import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';

/**
 * Shared settings presentation, loaded with the existing settings routes.
 * Global selectors let account and admin panels share the same tokens.
 */
@Component({
  selector: 'app-settings-styles',
  template: '',
  styleUrl: '../../styles/_settings.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsStyles {}
