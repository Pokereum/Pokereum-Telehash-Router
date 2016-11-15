var
        http = require('http'),
        fs = require('fs'),
        Telehash = require('telehash'),
        TELEHASH_TRANSPORT_PORT = 42427,
        REVEAL_ROUTER_PORT = 48484,
        MESH_BROADCAST_FILENAME = 'broadcast.router.json',
        MESH_CONFIG = {
            id: 'router.mesh.json',
            http: {'port': TELEHASH_TRANSPORT_PORT},
        },
        active_links = {};

delete Telehash.extensions.udp4;
delete Telehash.extensions.tcp4;

init_router();

function init_router() {
    http.get({host: 'api.ipify.org'}, function (res) {
        if (res.statusCode !== 200) {
            start_router();
            return;
        }
        var ip = '';

        res.on('data', function (data) {
            ip += data;
        });

        res.on('end', function () {
            MESH_CONFIG.ipv4 = ip;
            start_router();
        });
    }).on('error', function (err) {
        start_router();
    });
}

function start_router() {
    Telehash.load(MESH_CONFIG, function (err, mesh) {
        if (err) {
            throw err;
        }
        // Save mesh info to a json file
        fs.writeFile(MESH_BROADCAST_FILENAME, JSON.stringify(mesh.json()), function (err) {
            if (err) {
                return console.error('Error saving mesh JSON', err);
            }
        });

        // Prepare router mesh
        mesh.accept = mesh.link; // auto link any
        mesh.router(true);
        mesh.extending({
            link: function (link) {
                on_link(mesh, link);
            }
        });

        console.log('Router up: ', 'http://' + MESH_CONFIG.ipv4 + ':' + TELEHASH_TRANSPORT_PORT);

        reveal_router();
        fs.readFile(MESH_BROADCAST_FILENAME, function (error, content) {
            console.log('Telehash mesh JSON: ' + JSON.stringify(content.toString()));
        });

        setInterval(check_active_links, 60000);
    });
}

function check_active_links() {
    for (var hashname in active_links) {
        var active_link = active_links[hashname];

        active_link.ttl--;

        if (active_link.ttl === 0) {
            console.log('Forgetting about', hashname);
            delete active_links[hashname];
        }
    }
}

function reveal_router() {
    http.createServer(function (request, response) {
        fs.readFile(MESH_BROADCAST_FILENAME, function (error, content) {
            if (error) {
                response.writeHead(500);
                response.end('Router is down.');
                response.end();
            } else {
                response.writeHead(200);
                response.end(content, 'utf-8');
            }
        });
    }).listen(REVEAL_ROUTER_PORT);
    console.log('Get Telehash mesh JSON from:', 'http://' + MESH_CONFIG.ipv4 + ':' + REVEAL_ROUTER_PORT);
}


function on_link(mesh, link) {
    try {
        if (typeof active_links[link.hashname] === 'undefined') {
            active_links[link.hashname] = link;
            active_links[link.hashname].clientPrivate = true;
            active_links[link.hashname].ttl = 2;
            console.log('new link', link.hashname);

            // Create stream to broadcast the new link to others
            mesh.stream(on_new_stream);

            // Link status update handler
            link.status(function (err) {
                on_link_status_update(err, link);
            });
        }
    } catch (e) {
        console.log(e);
    }
}

function on_new_stream(link, args, accept) {
    try {
        var chan = accept();

        chan.on('data', function (message) {
            try {
                message = JSON.parse(message.toString());
            } catch (e) {
                console.log('failed parsing message: ' + e, message.toString());
                return;
            }

            switch (message.type) {
                case 'introduce_me':
                    active_links[link.hashname].clientPrivate = false;
                    broadcast(link, message.to);
                    break;
                case 'bye':
                    active_links[link.hashname].close();
                    delete active_links[link.hashname];
                    break;
            }
        });

    } catch (e) {
        console.log(e);
    }
}

function broadcast(link, to) {
    if (!to || to == 'all') {
        for (var hashname in active_links) {
            var active_link = active_links[hashname];

            if (active_link && active_link.clientPrivate === false && hashname != link.hashname && active_link.up === true) {
                var message = {'type': 'router_broadcast', 'hashname': active_link.hashname, 'linkJSON': active_link.json};

                link.stream().write(JSON.stringify(message));
                console.log('connecting ' + hashname + ' to ' + link.hashname);
            }
        }
    } else {
        if (typeof active_links[to] !== 'undefined') {
            var active_link = active_links[to];
            var message = {'type': 'router_broadcast', 'hashname': active_link.hashname, 'linkJSON': active_link.json};

            link.stream().write(JSON.stringify(message));
            console.log('connecting ' + hashname + ' to ' + link.hashname);
        }
    }
}

function on_link_status_update(err, link) {
    if (link.up === false) {
        active_links[link.hashname].close();
        delete active_links[link.hashname];
    }
    console.log(link.hashname.substr(0, 8), err ? 'down' : 'up', err || '');
}