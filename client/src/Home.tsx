import './theme/components.css';
import './theme/phone.css';
import { APP_NAME } from './appName.js';
import { PhoneShell } from './ui/PhoneShell.js';

/** The front page. Guests join by scanning the TV, so this only points the presenter to sign in. */
export default function Home() {
  return (
    <PhoneShell>
      <main className="sheet">
        <header className="masthead">
          <p className="kicker">{APP_NAME}</p>
          <h1 className="deck-title">Scan the code on the TV to join</h1>
        </header>
        <p className="home-body">
          Presenting? <a href="/admin">Sign in</a> to build a deck and start a game.
        </p>
      </main>
    </PhoneShell>
  );
}
