mergeInto(LibraryManager.library, {
    $CVMFS__deps: ['$FS'],
    $CVMFS: {
      ops_table: null,
      data_url: null,
      catalog: null,
      default_mountpoint: "/cvmfs",
      relativePath: function(path) {
        var rel = path.replace(CVMFS.default_mountpoint, '');
        return rel;
      },
      md5HexToPair: function(md5hex) {
        var bytes = new Array(16);

        var i = md5hex.length - 2;
        while (i >= 0) {
            bytes[15 - i/2] = md5hex.substr(i, 2);
            i -= 2;
        }
        
        return {
          low: "0x" + bytes.slice(0, bytes.length/2).join(''),
          high: "0x" + bytes.slice(bytes.length/2).join('')
        };
      },
      md5PairFromPath: function(path) {
        const md5Hex = window.md5(path);
        return CVMFS.md5HexToPair(md5Hex);
      },
      httpGet: function(url) {
        const request = new XMLHttpRequest();

        request.open('GET', url, false);
        request.overrideMimeType("text/plain; charset=x-user-defined");
        request.send(null);

        if (request.status === 200) {
          return request.responseText;
        }

        return null;
      },
      mount: function(mount) {
        CVMFS.base_url = mount.opts.base_url;
        const manifest_url = mount.opts.base_url + "/.cvmfspublished";

        const resp1 = CVMFS.httpGet(manifest_url);
        if (resp1 !== null) {
          const lines = resp1.split("\n");
          const catalog_hash = lines.filter(function (line) {
            return line.charAt(0) === 'C';
          })[0].substr(1);

          if (catalog_hash !== null) {
            CVMFS.data_url = mount.opts.base_url + "/data/";

            const catalog_url = CVMFS.data_url + catalog_hash.substr(0, 2) + "/" + catalog_hash.substr(2) + "C";
            const resp2 = CVMFS.httpGet(catalog_url);

            if (resp2 !== null) {
              const decompressed = pako.inflate(resp2);
              CVMFS.catalog = new window.SQL.Database(decompressed);
              return CVMFS.createNode(null, '/', {{{ cDefine('S_IFDIR') }}} | 511, 0);
            }
          }
        }
        return null;
      },
      createNode: function(parent, name, mode, dev) {
        if (!CVMFS.ops_table) {
          CVMFS.ops_table = {
            dir: {
              node: {
                getattr: CVMFS.node_ops.getattr,
                lookup: CVMFS.node_ops.lookup,
                readdir: CVMFS.node_ops.readdir,
                symlink: CVMFS.node_ops.symlink
              },
              stream: {}
            },
            file: {
              node: {
                getattr: CVMFS.node_ops.getattr,
              },
              stream: {
                read: CVMFS.stream_ops.read,
              }
            },
            link: {
              node: {
                getattr: CVMFS.node_ops.getattr,
                readlink: CVMFS.node_ops.readlink
              },
              stream: {}
            }
          };
        }

        var node = FS.createNode(parent, name, mode, dev);

        if (FS.isDir(node.mode)) {
          node.node_ops = CVMFS.ops_table.dir.node;
          node.stream_ops = CVMFS.ops_table.dir.stream;
          node.contents = {};
        } else if (FS.isFile(node.mode)) {
          node.node_ops = CVMFS.ops_table.file.node;
          node.stream_ops = CVMFS.ops_table.file.stream;
          node.usedBytes = 0;
          node.contents = null; 
        }

        node.timestamp = Date.now();

        if (parent) {
          parent.contents[name] = node;
        }

        return node;
      },
      flagsIsDir: function(flags) { return flags === 1; },
      flagsIsRegFile: function(flags) { return flags === 4; },
      node_ops: {
        lookup: function(parent, name) {
          const path = CVMFS.relativePath(PATH.join(FS.getPath(parent), name));
          const pair = CVMFS.md5PairFromPath(path);

          const query = "SELECT flags FROM catalog WHERE md5path_1 = " + pair.high + " AND md5path_2 = " + pair.low;
          const result = CVMFS.catalog.exec(query);
          if (result[0] === undefined) {
            throw FS.genericErrors[ERRNO_CODES.ENOENT];
          }
          const flags = result[0].values[0][0];

          var mode = 511;
          if (CVMFS.flagsIsDir(flags)) {
            mode |= {{{ cDefine('S_IFDIR') }}};
          } else if (CVMFS.flagsIsRegFile(flags)) {
            mode |= {{{ cDefine('S_IFREG') }}};
          } else {
            throw FS.genericErrors[ERRNO_CODES.ENOENT];
          }

          return CVMFS.createNode(parent, name, mode, 0);
        },
        readdir: function(node) {
          var entries = ['.', '..'];
          
          const path = CVMFS.relativePath(FS.getPath(node));
          const pair = CVMFS.md5PairFromPath(path);

          const query = "SELECT name, flags FROM catalog WHERE parent_1 = " + pair.high + " AND parent_2 = " + pair.low;
          const result = CVMFS.catalog.exec(query);
          if (result[0] !== undefined) {
            for (const entry of result[0].values) {
              const flags = entry[1];
              if (CVMFS.flagsIsDir(flags) || CVMFS.flagsIsRegFile(flags)) {
                entries.push(entry[0]);
              }
            }
          }

          return entries;
        },
      },
      stream_ops: {
        read: function(stream, buffer, offset, length, position) {
          const path = CVMFS.relativePath(stream.path);
          const pair = CVMFS.md5PairFromPath(path);
          
          const query = "SELECT hex(hash) FROM catalog WHERE md5path_1 = " + pair.high + " AND md5path_2 = " + pair.low;
          const result = CVMFS.catalog.exec(query);

          const file_hash = result[0].values[0][0].toLowerCase();
          const file_url = CVMFS.data_url + file_hash.substr(0, 2) + "/" + file_hash.substr(2);

          const resp = CVMFS.httpGet(file_url);
          if (resp !== null) {
            const contents = pako.inflate(resp);

            if (position >= contents.length) return 0;
            const size = Math.min(contents.length - position, length);
            buffer.set(contents.subarray(position, position + size), offset);

            return size;
          }

          return 0;
        }
      }
    }
});
  
  