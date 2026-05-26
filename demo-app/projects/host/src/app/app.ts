import { Component, ViewContainerRef, OnInit, ViewChild } from '@angular/core';
import { RouterModule } from '@angular/router';
import { loadRemoteModule } from '@angular-mf/core/runtime';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterModule],
  template: `
    <div style="padding: 20px; font-family: sans-serif;">
      <div style="border: 2px dashed blue; padding: 20px; border-radius: 8px;">
        <h1 style="color: blue;">Host Application</h1>
        <p>This is the Host application running on port 4200.</p>
        
        <nav style="margin-bottom: 20px;">
          <a routerLink="/" style="margin-right: 15px;">Home</a>
          <a routerLink="/feature" style="margin-right: 15px;">Load Remote Router</a>
        </nav>

        <router-outlet></router-outlet>
        
        <h2 style="margin-top: 40px;">Remote Component Load:</h2>
        <div style="border: 2px solid red; padding: 20px; border-radius: 8px;">
          <!-- Container for Remote Component -->
          <ng-container #remoteContainer></ng-container>
        </div>
      </div>
    </div>
  `
})
export class App implements OnInit {
  @ViewChild('remoteContainer', { read: ViewContainerRef, static: true })
  remoteContainer!: ViewContainerRef;

  async ngOnInit() {
    try {
      console.log('Loading remote module...');
      const m = await loadRemoteModule({
        remoteName: 'remote',
        exposedModule: './GreetingComponent'
      });
      console.log('Remote module loaded successfully', m);
      this.remoteContainer.createComponent((m as any).Greeting); 
    } catch (e) {
      console.error('Error loading remote module', e);
    }
  }
}
