#!/usr/bin/python3
"""Run the native CLI with connect/sendto restricted to the owned loopback server.

Linux x86-64 seccomp user notification: inspect sockaddr in the stopped child.
No request payloads or credential values are read or retained.
"""
import array
import ctypes
import errno
import os
import select
import signal
import socket
import struct
import sys

if sys.platform != "linux" or os.uname().machine != "x86_64":
    sys.exit("Native contract network guard requires Linux x86-64.")

libc = ctypes.CDLL(None, use_errno=True)
class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]
class Data(ctypes.Structure):
    _fields_ = [("nr", ctypes.c_int), ("arch", ctypes.c_uint), ("ip", ctypes.c_ulonglong), ("args", ctypes.c_ulonglong * 6)]
class Notification(ctypes.Structure):
    _fields_ = [("id", ctypes.c_ulonglong), ("pid", ctypes.c_uint), ("flags", ctypes.c_uint), ("data", Data)]
class Response(ctypes.Structure):
    _fields_ = [("id", ctypes.c_ulonglong), ("value", ctypes.c_longlong), ("error", ctypes.c_int), ("flags", ctypes.c_uint)]
class Iovec(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("length", ctypes.c_size_t)]

parent, child_socket = socket.socketpair()
pid = os.fork()
if pid == 0:
    parent.close()
    # Refuse non-x86-64 syscalls; notify on connect and destination-bearing sendto.
    rules = [Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, 0xC000003E), Filter(0x06, 0, 0, 0),
             Filter(0x20, 0, 0, 0),
             # Internet sockets must be TCP streams; no UDP/raw DNS or sendmsg escape.
             Filter(0x15, 0, 8, 41), Filter(0x20, 0, 0, 16), Filter(0x15, 1, 0, 2),
             Filter(0x15, 0, 4, 10), Filter(0x20, 0, 0, 24), Filter(0x54, 0, 0, 15),
             Filter(0x15, 1, 0, 1), Filter(0x06, 0, 0, 0x00050001), Filter(0x06, 0, 0, 0x7FFF0000),
             Filter(0x15, 0, 1, 42), Filter(0x06, 0, 0, 0x7FC00000),
             Filter(0x15, 0, 3, 44), Filter(0x20, 0, 0, 48), Filter(0x15, 1, 0, 0),
             Filter(0x06, 0, 0, 0x7FC00000), Filter(0x06, 0, 0, 0x7FFF0000)]
    filters = (Filter * len(rules))(*rules)
    program = Program(len(rules), filters)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        os._exit(120)
    listener = libc.syscall(317, 1, 8, ctypes.byref(program))
    if listener < 0:
        os._exit(121)
    child_socket.sendmsg([b"L"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [listener]))])
    os.close(listener)
    child_socket.close()
    os.execv(sys.argv[1], sys.argv[1:])

child_socket.close()
_, ancillary, _, _ = parent.recvmsg(1, socket.CMSG_SPACE(4))
parent.close()
if not ancillary:
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
listener = array.array("i", ancillary[0][2])[0]
port = int(os.environ["NATIVE_CONTRACT_PORT"])

def forward(sig, _frame):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, forward)
signal.signal(signal.SIGINT, forward)

def read_address(notice, pointer, length):
    if length < 2 or length > 128:
        return False
    buffer = ctypes.create_string_buffer(length)
    local = Iovec(ctypes.cast(buffer, ctypes.c_void_p), length)
    remote = Iovec(pointer, length)
    size = libc.process_vm_readv(notice.pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0)
    if size != length:
        return False
    address = buffer.raw
    family = struct.unpack_from("H", address)[0]
    if family == socket.AF_UNIX:
        return True
    if family == socket.AF_INET and length >= 16:
        return struct.unpack_from("!H", address, 2)[0] == port and address[4:8] == socket.inet_aton("127.0.0.1")
    return False

while True:
    ended, status = os.waitpid(pid, os.WNOHANG)
    if ended:
        os.close(listener)
        code = os.waitstatus_to_exitcode(status)
        sys.exit(code if code >= 0 else 128 - code)
    if not select.select([listener], [], [], 0.05)[0]:
        continue
    notice = Notification()
    if libc.ioctl(listener, 0xC0502100, ctypes.byref(notice)) != 0:
        if ctypes.get_errno() in (errno.ENOENT, errno.EINTR):
            continue
        sys.exit("Cannot receive network authorization notification.")
    args = notice.data.args
    pointer, length = (args[1], args[2]) if notice.data.nr == 42 else (args[4], args[5])
    allowed = read_address(notice, pointer, length)
    answer = Response(notice.id, 0, 0 if allowed else -errno.EPERM, 1 if allowed else 0)
    if libc.ioctl(listener, 0xC0182101, ctypes.byref(answer)) != 0 and ctypes.get_errno() != errno.ENOENT:
        sys.exit("Cannot respond to network authorization notification.")
