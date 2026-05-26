import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-feature',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div style="border: 2px dashed blue; padding: 20px; border-radius: 8px;">
      <h2>Hello from Remote Feature Router!</h2>
      <p>This component was loaded via Angular Router using Module Federation.</p>
    </div>
  `
})
export class FeatureComponent {}
