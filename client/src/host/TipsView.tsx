import type { TipsScreen } from '../../../shared/protocol.js';
import { mediaUrl } from '../theme/games.js';
import { hasPlaces, TipsMap } from '../ui/tips.js';

/** The night's last page: what you'd tell a friend going next, with the places on a map. */
export function TipsView({ screen, title }: { screen: TipsScreen; title: string }) {
  const mapped = hasPlaces(screen.tips);
  const many = screen.tips.length > 4;
  return (
    <>
      <header className="tv-header tips-head">
        <div>
          <p className="tv-kicker">{title}</p>
          <h1 className="tv-title">If you go</h1>
        </div>
        <p className="tips-phone-note">It's all on your phone, ready to copy</p>
      </header>
      <div className={mapped ? 'tips-board mapped' : 'tips-board'}>
        <ol className={many ? 'tips-list many' : 'tips-list'}>
          {screen.tips.map((tip, index) => (
            <li key={index} className="tip-card" style={{ animationDelay: `${index * 120}ms` }}>
              {tip.image ? <img className="tip-photo" src={mediaUrl(tip.image, 'full')} alt="" /> : null}
              <div className="tip-words">
                <p className="tip-heading">
                  <span className="tip-number">{index + 1}</span>
                  {tip.heading}
                </p>
                {tip.text ? <p className="tip-text">{tip.text}</p> : null}
                {tip.places.length > 0 && tip.places.some((place) => place.name && !tip.text.includes(place.name)) ? (
                  <p className="tip-places">{tip.places.map((place) => place.name).filter(Boolean).join(' · ')}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {/* Numbers only: they match the list, and names beside nearby places would overlap. */}
        {mapped ? (
          <TipsMap className="tv-map tips-map" tips={screen.tips} interactive={false} padding={70} />
        ) : null}
      </div>
    </>
  );
}
