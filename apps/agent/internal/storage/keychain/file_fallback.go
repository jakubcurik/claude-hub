// SPDX-License-Identifier: Apache-2.0
package keychain

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
)

type FileStore struct {
	path string
	key  []byte
	mu   sync.Mutex
}

func NewFileStore(path string, key []byte) (*FileStore, error) {
	if len(key) != 32 {
		return nil, errors.New("keychain: file fallback requires 32-byte key")
	}
	return &FileStore{path: path, key: key}, nil
}

func (f *FileStore) load() (map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(f.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < gcm.NonceSize() {
		return nil, errors.New("keychain: file ciphertext too short")
	}
	nonce, ct := data[:gcm.NonceSize()], data[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	if err := json.Unmarshal(pt, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func (f *FileStore) save(m map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	pt, err := json.Marshal(m)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(f.key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	ct := gcm.Seal(nonce, nonce, pt, nil)
	return os.WriteFile(f.path, ct, 0o600)
}

func (f *FileStore) Set(k, v string) error {
	m, err := f.load()
	if err != nil {
		return err
	}
	m[k] = v
	return f.save(m)
}

func (f *FileStore) Get(k string) (string, error) {
	m, err := f.load()
	if err != nil {
		return "", err
	}
	v, ok := m[k]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

func (f *FileStore) Delete(k string) error {
	m, err := f.load()
	if err != nil {
		return err
	}
	if _, ok := m[k]; !ok {
		return ErrNotFound
	}
	delete(m, k)
	return f.save(m)
}
