emcc do_nothing.c -O1 \
    -o index.html \
    --shell-file cvmfs-template.html \
    -s DEMANGLE_SUPPORT=1 \
    -s FORCE_FILESYSTEM=1 \
    --js-library library_cvmfs.js \
    --js-library library_fs.js