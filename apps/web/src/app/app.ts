import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Root component: the application shell that hosts the router outlet.
 *
 * The title is a placeholder; from M6 it comes from the admin branding
 * settings so no product or employer name is baked into the build.
 */
@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  /** Name shown in the shell header. */
  protected readonly title = signal('Kloister');
}
