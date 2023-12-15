const express = require('express');
const path = require('path');
const SpotifyWebApi = require('spotify-web-api-node');
const mysql = require('mysql2');
const ejs = require('ejs');
const session = require('express-session');
const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const SPOTIFY_CLIENT_ID = '1027a6451c8543919e5d8bb3fed8acf6';
const SPOTIFY_CLIENT_SECRET = '10c61a8cef9b4e8ab81b93c595dbf648';
const SPOTIFY_CALLBACK_URL = 'https://5cf0-88-242-67-117.ngrok-free.app/callback';

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '10377920Efe',
  database: 'spotify',
});

const spotifyApi = new SpotifyWebApi({
  clientId: SPOTIFY_CLIENT_ID,
  clientSecret: SPOTIFY_CLIENT_SECRET,
  redirectUri: SPOTIFY_CALLBACK_URL,
});

app.use(session({
  secret: 'ronin123',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    maxAge: 30 * 60 * 1000, 
    secure: false,
  },
}));


app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function saveOrUpdateUserProfile(userId, genres, topArtists, topTracks, display_name, profile_image_url) {
  db.query('SELECT * FROM userdb WHERE userId = ?', [userId], (err, userResult) => {
    if (err) {
      console.error(err);
    } else {
      if (userResult.length === 0) {
        db.query(
          'INSERT INTO userdb (userId, genre, topartist, toptracks, display_name, profile_image_url) VALUES (?, ?, ?, ?, ?, ?)',
          [userId, JSON.stringify(genres), JSON.stringify(topArtists), JSON.stringify(topTracks), display_name, profile_image_url],
          (err, results) => {
            if (err) {
              console.error(err);
            } else {
              console.log('User profile data saved successfully.');
            }
          }
        );
      } else {
        const updatedGenres = [...new Set([...userResult[0].genre, ...genres])];
        const updatedTopArtists = [...new Set([...userResult[0].topartist, ...topArtists])];
        const updatedTopTracks = [...userResult[0].toptracks, ...topTracks];

        db.query(
          'UPDATE userdb SET genre = ?, topartist = ?, toptracks = ?, display_name = ?, profile_image_url = ? WHERE userId = ?',
          [JSON.stringify(updatedGenres), JSON.stringify(updatedTopArtists), JSON.stringify(updatedTopTracks), display_name, profile_image_url, userId],
          (err, results) => {
            if (err) {
              console.error(err);
            } else {
              console.log('User profile data updated successfully');
            }
          }
        );
      }
    }
  });
}

const profileKey = 'spotify-profile';

app.get('/profile', (req, res) => {
  const code = req.query.code;

  let userId;
  let display_name;
  let profile_image_url;

  const profile = req.session[profileKey] || {};
  if (profile.connected && profile.lastConnected && (Date.now() - profile.lastConnected < 30 * 60 * 1000)) {
    res.redirect(`/matchUsers?userId=${profile.userId}`);
    return;
  }

  spotifyApi.authorizationCodeGrant(code)
    .then(data => {
      const accessToken = data.body.access_token;
      spotifyApi.setAccessToken(accessToken);
      return Promise.all([
        spotifyApi.getMe(),
      ]);
    })
    .then(results => {
      if (!results[0] || !results[0].body) {
        throw new Error('One or more Spotify API responses or bodies are undefined.');
      }

      userId = results[0].body.id;
      display_name = results[0].body.display_name || 'Unknown';
      profile_image_url = results[0].body.images.length > 0 ? results[0].body.images[0].url : null;

      return Promise.all([
        spotifyApi.getMyTopArtists({ limit: 5, time_range: 'long_term' }),
        spotifyApi.getMyTopTracks({ limit: 5, time_range: 'long_term' }),
      ]);
    })
    .then(results => {
      if (!results[0] || !results[0].body || !results[0].body.items ||
          !results[1] || !results[1].body || !results[1].body.items) {
        throw new Error('One or more Spotify API responses or bodies are undefined.');
      }

      const topArtists = results[0].body.items.map(item => item.name);
      const genres = results[0].body.items.map(item => item.genres).flat();
      const uniqueGenres = [...new Set(genres)];

      const topTracks = results[1].body.items.map(item => {
        return {
          name: item.name,
        };
      });

      req.session[profileKey] = {
        connected: true,
        userId: userId,
        lastConnected: Date.now(),
      };

      saveOrUpdateUserProfile(userId, uniqueGenres, topArtists, topTracks, display_name, profile_image_url);

      res.redirect(`/matchUsers?userId=${userId}`);

    })
    .catch(error => {
      console.error(error);
      res.status(500).send('Internal Server Error');
    });
});

app.get('/matchUsers', (req, res) => {
  const userId = req.query.userId;

  db.query('SELECT * FROM userdb WHERE userId = ?', [userId], (err, userResult) => {
    if (err) {
      console.error(err);
      res.status(500).send('Internal Server Error');
      return;
    }

    if (userResult.length === 0) {
      res.status(404).send('User not found');
      return;
    }

    const userGenres = userResult[0].genre;
    const userTopArtists = userResult[0].topartist;
    const userTopTracks = userResult[0].toptracks;

    db.query('SELECT * FROM userdb WHERE userId <> ?', [userId], (err, allUsersResult) => {
      if (err) {
        console.error(err);
        res.status(500).send('Internal Server Error');
        return;
      }

      const matchingUsers = [];
      allUsersResult.forEach(otherUser => {
        const otherUserId = otherUser.userId;
        const otherUserName = otherUser.display_name;
        const otherUserProfilePic = otherUser.profile_image_url;
        const otherUserGenres = otherUser.genre;
        const otherUserTopArtists = otherUser.topartist;
        const otherUserTopTracks = otherUser.toptracks;

        const genreMatchPercentage = calculateMatchPercentage(userGenres, otherUserGenres);
        const topArtistsMatchPercentage = calculateMatchPercentage(userTopArtists, otherUserTopArtists);
        const topTracksMatchPercentage = calculateMatchPercentage(userTopTracks, otherUserTopTracks);

        const overallMatchPercentage = (genreMatchPercentage + topArtistsMatchPercentage + topTracksMatchPercentage) / 3;

        if (overallMatchPercentage > 40) {
          matchingUsers.push({
            userId: otherUserId,
            username: otherUserName,
            otherUserProfilePic: otherUserProfilePic,
            spotifyProfileLink: `https://open.spotify.com/user/${otherUserId}`,
            overallMatchPercentage: overallMatchPercentage,
            otherUserGenres: otherUserGenres,
            otherUserTopArtists: otherUserTopArtists,
            otherUserTopTracks: otherUserTopTracks,
          });
        }
      });

      matchingUsers.sort((a, b) => b.overallMatchPercentage - a.overallMatchPercentage);

      res.render('matchUsers', { matchedUsers: matchingUsers });
    });
  });
});





function calculateMatchPercentage(userArray, otherUserArray) {
  const commonElementsCount = userArray.filter(element => otherUserArray.includes(element)).length;
  const totalElementsCount = userArray.length + otherUserArray.length;
  const matchPercentage = (commonElementsCount / totalElementsCount) * 100;

  const increasedMatchPercentage = matchPercentage + 50;

  return Math.min(increasedMatchPercentage, 100);
}


app.get('/auth/spotify', (req, res) => {
  const profile = req.session[profileKey] || {};
  if (profile.connected && profile.lastConnected && (Date.now() - profile.lastConnected < 30 * 60 * 1000)) {
    res.redirect(`/matchUsers?userId=${profile.userId}`);
    return;
  }

  const authorizeURL = spotifyApi.createAuthorizeURL(['user-read-private', 'user-read-email', 'user-top-read'], null, 'token');
  res.redirect(authorizeURL);
});

app.get('/callback', (req, res) => {
  const code = req.query.code;
  res.redirect(`/profile?code=${code}`);
});


app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
